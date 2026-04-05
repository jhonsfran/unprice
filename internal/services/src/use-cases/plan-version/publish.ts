import { type Database, and, eq, inArray } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { type PlanVersion, calculateFlatPricePlan } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { isZero } from "dinero.js"
import type { ServiceContext } from "../../context"
import { toErrorContext } from "../../utils/log-context"

type PublishPlanVersionDeps = {
  services: Pick<ServiceContext, "customers">
  db: Database
  logger: Logger
  userId: string
}

type PublishPlanVersionInput = {
  id: string
  projectId: string
  workspaceUnPriceCustomerId: string
}

export async function publishPlanVersion(
  deps: PublishPlanVersionDeps,
  input: PublishPlanVersionInput
): Promise<
  Result<
    | {
        state:
          | "version_not_found"
          | "already_published"
          | "no_features"
          | "price_calculation_error"
          | "payment_provider_error"
          | "publish_error"
      }
    | { state: "ok"; planVersion: PlanVersion },
    FetchError
  >
> {
  const { id, projectId, workspaceUnPriceCustomerId } = input

  deps.logger.set({
    business: {
      operation: "plan-version.publish",
      project_id: projectId,
      unprice_customer_id: workspaceUnPriceCustomerId,
    },
  })

  const planVersionData = await deps.db.query.versions.findFirst({
    with: {
      planFeatures: {
        with: {
          feature: true,
        },
      },
      project: true,
      plan: true,
    },
    where: (version, { and, eq }) => and(eq(version.id, id), eq(version.projectId, projectId)),
  })

  if (!planVersionData?.id) {
    return Ok({
      state: "version_not_found",
    })
  }

  if (planVersionData.status === "published") {
    return Ok({
      state: "already_published",
    })
  }

  if (planVersionData.planFeatures.length === 0) {
    return Ok({
      state: "no_features",
    })
  }

  const { err, val: totalPricePlan } = calculateFlatPricePlan({
    planVersion: planVersionData,
  })

  if (err) {
    return Ok({
      state: "price_calculation_error",
    })
  }

  const paymentMethodRequired = !isZero(totalPricePlan.dinero)

  if (paymentMethodRequired) {
    const { err: validatePaymentMethodErr } = await deps.services.customers.getPaymentProvider({
      customerId: workspaceUnPriceCustomerId,
      projectId,
      provider: planVersionData.paymentProvider,
    })

    if (validatePaymentMethodErr) {
      return Ok({
        state: "payment_provider_error",
      })
    }
  }

  let updated: PlanVersion | null = null

  try {
    updated = await deps.db.transaction(async (tx) => {
      const flatFeaturesIds = planVersionData.planFeatures
        .filter((feature) => ["flat", "package", "tier"].includes(feature.featureType))
        .map((feature) => feature.id)

      if (flatFeaturesIds.length > 0) {
        const planVersionFeaturesUpdated = await tx
          .update(schema.planVersionFeatures)
          .set({
            billingConfig: planVersionData.billingConfig,
          })
          .where(
            and(
              inArray(schema.planVersionFeatures.id, flatFeaturesIds),
              eq(schema.planVersionFeatures.projectId, projectId),
              inArray(schema.planVersionFeatures.featureType, ["flat", "package", "tier"])
            )
          )
          .returning()
          .then((rows) => rows[0])

        if (!planVersionFeaturesUpdated) {
          throw new FetchError({
            message: "Error publishing version",
            retry: false,
          })
        }
      }

      await tx
        .update(schema.versions)
        .set({
          latest: false,
        })
        .where(
          and(
            eq(schema.versions.projectId, projectId),
            eq(schema.versions.latest, true),
            eq(schema.versions.planId, planVersionData.planId)
          )
        )

      const versionUpdated = await tx
        .update(schema.versions)
        .set({
          status: "published",
          updatedAtM: Date.now(),
          publishedAt: Date.now(),
          publishedBy: deps.userId,
          latest: true,
          paymentMethodRequired,
        })
        .where(and(eq(schema.versions.id, planVersionData.id)))
        .returning()
        .then((rows) => rows[0] ?? null)

      if (!versionUpdated) {
        throw new FetchError({
          message: "Error publishing version",
          retry: false,
        })
      }

      return versionUpdated
    })
  } catch (error) {
    const publishErr = error as Error
    deps.logger.error("error publishing plan version", {
      error: toErrorContext(publishErr),
      projectId,
      planVersionId: id,
    })

    return Err(
      new FetchError({
        message: `error publishing version: ${publishErr.message}`,
        retry: false,
      })
    )
  }

  if (!updated) {
    return Ok({
      state: "publish_error",
    })
  }

  return Ok({
    state: "ok",
    planVersion: updated,
  })
}
