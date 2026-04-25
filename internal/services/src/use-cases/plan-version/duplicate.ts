import { type Database, and, eq, sql } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { PlanVersion } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"

type DuplicatePlanVersionDeps = {
  db: Database
  logger: Logger
}

type DuplicatePlanVersionInput = {
  id: string
  projectId: string
}

export async function duplicatePlanVersion(
  deps: DuplicatePlanVersionDeps,
  input: DuplicatePlanVersionInput
): Promise<
  Result<
    | {
        state: "not_found" | "default_plan_payment_method_conflict" | "duplicate_error"
      }
    | { state: "ok"; planVersion: PlanVersion },
    FetchError
  >
> {
  const { id, projectId } = input

  deps.logger.set({
    business: {
      operation: "plan-version.duplicate",
      project_id: projectId,
    },
  })

  try {
    const planVersionData = await deps.db.query.versions.findFirst({
      where: (version, { and, eq }) => and(eq(version.id, id), eq(version.projectId, projectId)),
      with: {
        planFeatures: true,
        plan: true,
      },
    })

    if (!planVersionData?.id) {
      return Ok({ state: "not_found" })
    }

    if (planVersionData.plan.defaultPlan && planVersionData.paymentMethodRequired) {
      return Ok({ state: "default_plan_payment_method_conflict" })
    }

    const planVersionId = newId("plan_version")

    const duplicated = await deps.db.transaction(async (tx) => {
      const countVersionsPlan = await tx
        .select({ count: sql<number>`count(*)` })
        .from(schema.versions)
        .where(
          and(
            eq(schema.versions.projectId, projectId),
            eq(schema.versions.planId, planVersionData.planId)
          )
        )
        .then((rows) => rows[0]?.count ?? 0)

      const version = await tx
        .insert(schema.versions)
        .values({
          ...planVersionData,
          id: planVersionId,
          trialUnits: planVersionData.trialUnits,
          billingConfig: planVersionData.billingConfig,
          autoRenew: planVersionData.autoRenew,
          paymentMethodRequired: planVersionData.paymentMethodRequired,
          metadata: {},
          latest: false,
          active: true,
          status: "draft",
          createdAtM: Date.now(),
          updatedAtM: Date.now(),
          version: Number(countVersionsPlan) + 1,
        })
        .returning()
        .then((rows) => rows[0] ?? null)

      if (!version?.id) {
        return null
      }

      await Promise.all(
        planVersionData.planFeatures.map(async (feature) => {
          await tx.insert(schema.planVersionFeatures).values({
            ...feature,
            id: newId("feature_version"),
            planVersionId,
            metadata: feature.metadata,
            createdAtM: Date.now(),
            updatedAtM: Date.now(),
          })
        })
      )

      return version
    })

    if (!duplicated) {
      return Ok({
        state: "duplicate_error",
      })
    }

    return Ok({
      state: "ok",
      planVersion: duplicated,
    })
  } catch (error) {
    const e = error as Error
    deps.logger.error(e, {
      context: "error duplicating plan version",
      projectId,
      planVersionId: id,
    })

    return Err(
      new FetchError({
        message: `error duplicating plan version: ${e.message}`,
        retry: false,
      })
    )
  }
}
