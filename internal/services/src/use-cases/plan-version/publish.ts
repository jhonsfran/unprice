import { type Database, and, eq, inArray } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import type { PlanVersion } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import { priceCanCharge } from "../../pricing"
import { type FeatureViolation, planVersionViolations } from "../../rate-cards"
import { toErrorContext } from "../../utils/log-context"

export type PublishPlanVersionDeps = {
  services: Pick<ServiceContext, "customers" | "rateCards">
  db: Database
  logger: Logger
  userId: string
}

export type PublishPlanVersionInput = {
  id: string
  projectId: string
  workspaceUnPriceCustomerId: string
}

export type PublishPlanVersionOutput =
  | {
      state:
        | "version_not_found"
        | "already_published"
        | "no_features"
        | "payment_provider_error"
        | "publish_error"
    }
  | z.infer<typeof unpricedPlanVersionSchema>
  /**
   * The card's rows, read under the card's lock, break a pricing rule for the version's own
   * features: a row matching a dimension the feature no longer has, tiers on a feature that varies
   * by model, and so on. The budget would refuse to price with it, so the version cannot ship.
   */
  | { state: "invalid_rows"; violations: FeatureViolation[] }
  | { state: "ok"; planVersion: PlanVersion }

/**
 * A version that would ship free (ADR-0008 D2): it has no card in its currency (`no_card`), or
 * `featureSlugs` have no current or scheduled row on that card (`missing_rows`).
 */
export const unpricedPlanVersionSchema = z.object({
  state: z.literal("unpriced"),
  reason: z.enum(["no_card", "missing_rows"]),
  featureSlugs: z.array(z.string()),
})

export async function publishPlanVersion(
  deps: PublishPlanVersionDeps,
  input: PublishPlanVersionInput
): Promise<Result<PublishPlanVersionOutput, FetchError>> {
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

  // ADR-0008 D2: the version's card in its currency owns every price. A customer needs a payment
  // method when the version charges automatically and any row, now or scheduled, can charge.
  const now = Date.now()
  const pricing = await deps.services.rateCards.pricingForPlanVersions(
    projectId,
    [planVersionData.id],
    now,
    Number.MAX_SAFE_INTEGER
  )
  const card = pricing
    .get(planVersionData.id)
    ?.find((entry) => entry.currency === planVersionData.currency)
  if (!card) {
    return Ok({ state: "unpriced", reason: "no_card", featureSlugs: [] })
  }
  const { rows } = card
  const featureSlugs = new Set(planVersionData.planFeatures.map(({ feature }) => feature.slug))
  // Every feature type bills through its row, so a feature without one would ship free.
  const unpriced = [...featureSlugs].filter((slug) => !rows.some((row) => row.featureSlug === slug))
  if (unpriced.length > 0) {
    return Ok({ state: "unpriced", reason: "missing_rows", featureSlugs: unpriced })
  }
  const paymentMethodRequired =
    planVersionData.collectionMethod === "charge_automatically" &&
    rows.some((row) => featureSlugs.has(row.featureSlug) && priceCanCharge(row.price))

  if (paymentMethodRequired) {
    const { err: validatePaymentMethodErr } = await deps.services.customers.getPaymentProvider({
      projectId,
      provider: planVersionData.paymentProvider,
    })

    if (validatePaymentMethodErr) {
      deps.logger.error("payment provider validation failed while publishing plan version", {
        context: "error validating payment provider for plan version publish",
        projectId,
        planVersionId: id,
        provider: planVersionData.paymentProvider,
        paymentProvider: planVersionData.paymentProvider,
        paymentProviderError: toErrorContext(validatePaymentMethodErr),
        paymentProviderErrorCode:
          validatePaymentMethodErr instanceof Error && "code" in validatePaymentMethodErr
            ? validatePaymentMethodErr.code
            : undefined,
      })

      return Ok({
        state: "payment_provider_error",
      })
    }
  }

  let updated: { version: PlanVersion } | { invalid: FeatureViolation[] } | null = null

  try {
    updated = await deps.db.transaction(async (tx) => {
      // A row write on the card holds the same lock, so a publish never slips between a write's
      // read of whether the card is live and its commit; the rows checked here are the rows that
      // will be in force.
      await deps.services.rateCards.lockPlanVersionCards(projectId, planVersionData.id, tx)
      const lockedRows = await deps.services.rateCards.getEffectiveRows({
        projectId,
        cardIds: [card.card.id],
        from: now,
        to: Number.MAX_SAFE_INTEGER,
        executor: tx,
      })
      const violations = planVersionViolations(card.card, lockedRows, planVersionData.planFeatures)
      if (violations.length > 0) return { invalid: violations }

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

      return { version: versionUpdated }
    })
  } catch (error) {
    const publishErr = error as Error
    deps.logger.error(publishErr, {
      context: "error publishing plan version",
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

  if ("invalid" in updated) {
    return Ok({ state: "invalid_rows", violations: updated.invalid })
  }

  return Ok({
    state: "ok",
    planVersion: updated.version,
  })
}
