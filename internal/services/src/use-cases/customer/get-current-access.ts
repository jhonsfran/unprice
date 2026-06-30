import type { FeatureUsagePeriodRow } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { BillingConfig, ResetConfig } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import { computeGrantPeriodBucket, toGrantResetConfigFromBillingConfig } from "../../entitlements"

const entitlementFeatureTypeSchema = z.enum(["flat", "tier", "package", "usage"])

export const getCustomerCurrentAccessInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string(),
})

export const customerCurrentAccessPlanSchema = z.object({
  subscriptionId: z.string(),
  planSlug: z.string(),
  status: z.string(),
  currentCycleStartAt: z.number().int(),
  currentCycleEndAt: z.number().int(),
  renewAt: z.number().int().nullable(),
  timezone: z.string(),
  activePhase: z
    .object({
      id: z.string(),
      planVersionId: z.string(),
      creditLinePolicy: z.string(),
      creditLineAmount: z.number().int().nullable(),
      startAt: z.number().int(),
      endAt: z.number().int().nullable(),
    })
    .nullable(),
})

export const customerCurrentAccessEntitlementSchema = z.object({
  id: z.string(),
  featureSlug: z.string(),
  featureTitle: z.string(),
  featureType: entitlementFeatureTypeSchema,
  unitOfMeasure: z.string(),
  limit: z.number().int().nullable(),
  currentUsage: z.number().nullable(),
  usagePercent: z.number().nullable(),
  grantCount: z.number().int().nonnegative(),
  grantAllowance: z.number().int().nonnegative().nullable(),
  subscriptionId: z.string().nullable(),
  overageStrategy: z.string(),
})

export const getCustomerCurrentAccessOutputSchema = z.object({
  customerId: z.string(),
  generatedAt: z.number().int(),
  activePlan: customerCurrentAccessPlanSchema.nullable(),
  activeSubscriptionCount: z.number().int().nonnegative(),
  entitlementCount: z.number().int().nonnegative(),
  usageUnavailable: z.boolean(),
  usageWindow: z
    .object({
      start: z.number().int(),
      end: z.number().int(),
    })
    .nullable(),
  entitlements: customerCurrentAccessEntitlementSchema.array(),
})

export type GetCustomerCurrentAccessInput = z.infer<typeof getCustomerCurrentAccessInputSchema>
export type GetCustomerCurrentAccessOutput = z.infer<typeof getCustomerCurrentAccessOutputSchema>

export type GetCustomerCurrentAccessAnalytics = {
  getFeaturesUsagePeriod(params: {
    project_id: string
    customer_id?: string
    feature_slugs?: string[]
    period_key?: string
    start?: number
    end?: number
  }): Promise<{ data?: FeatureUsagePeriodRow[] }>
}

export type GetCustomerCurrentAccessDeps = {
  db: Database
  analytics: GetCustomerCurrentAccessAnalytics
  logger: Pick<Logger, "error">
  now?: () => number
}

type ActiveEntitlementRow = {
  effectiveAt: number
  expiresAt: number | null
  featurePlanVersion: {
    billingConfig: BillingConfig
    feature: {
      slug: string
    }
    featureType: string
    meterConfig: unknown | null
    resetConfig: ResetConfig | null
  }
  grants: Array<{
    effectiveAt: number
    expiresAt: number | null
    id: string
  }>
  id: string
}

type UsagePeriodScope = {
  featureSlug: string
  periodKey: string
}

export async function getCustomerCurrentAccess(
  deps: GetCustomerCurrentAccessDeps,
  rawInput: GetCustomerCurrentAccessInput
): Promise<Result<GetCustomerCurrentAccessOutput | null, FetchError>> {
  const input = getCustomerCurrentAccessInputSchema.parse(rawInput)
  const now = deps.now?.() ?? Date.now()

  const result = await wrapResult(
    (async () => {
      const customer = await deps.db.query.customers.findFirst({
        columns: {
          id: true,
        },
        where: (table, { and, eq }) =>
          and(eq(table.id, input.customerId), eq(table.projectId, input.projectId)),
      })

      if (!customer) {
        return null
      }

      const [activeSubscriptions, entitlements] = await Promise.all([
        deps.db.query.subscriptions.findMany({
          with: {
            phases: {
              columns: {
                id: true,
                planVersionId: true,
                creditLinePolicy: true,
                creditLineAmount: true,
                startAt: true,
                endAt: true,
              },
              where: (phase, { and, gte, isNull, lte, or }) =>
                and(lte(phase.startAt, now), or(isNull(phase.endAt), gte(phase.endAt, now))),
              orderBy: (phase, { desc }) => [desc(phase.startAt)],
              limit: 1,
            },
          },
          where: (subscription, { and, eq }) =>
            and(
              eq(subscription.projectId, input.projectId),
              eq(subscription.customerId, input.customerId),
              eq(subscription.active, true)
            ),
          orderBy: (subscription, { desc }) => [
            desc(subscription.currentCycleEndAt),
            desc(subscription.updatedAtM),
          ],
        }),
        deps.db.query.customerEntitlements.findMany({
          with: {
            featurePlanVersion: {
              with: {
                feature: true,
              },
            },
            grants: {
              where: (grant, { and, gt, isNull, lte, or }) =>
                and(
                  lte(grant.effectiveAt, now),
                  or(isNull(grant.expiresAt), gt(grant.expiresAt, now))
                ),
              orderBy: (grant, { asc, desc }) => [
                desc(grant.priority),
                asc(grant.expiresAt),
                asc(grant.id),
              ],
            },
          },
          where: (entitlement, { and, eq, gt, isNull, lte, or }) =>
            and(
              eq(entitlement.projectId, input.projectId),
              eq(entitlement.customerId, input.customerId),
              lte(entitlement.effectiveAt, now),
              or(isNull(entitlement.expiresAt), gt(entitlement.expiresAt, now))
            ),
        }),
      ])

      const activePlan = activeSubscriptions[0] ?? null
      const usageWindow = activePlan
        ? {
            start: activePlan.currentCycleStartAt,
            end: Math.min(activePlan.currentCycleEndAt, now),
          }
        : null
      const usagePeriodPlan =
        usageWindow && usageWindow.end > usageWindow.start
          ? buildUsagePeriodPlan({
              entitlements,
              timestamp: Math.max(usageWindow.start, usageWindow.end - 1),
            })
          : { scopes: [], periodKeysByEntitlementId: new Map<string, string[]>() }
      const usageResult =
        usagePeriodPlan.scopes.length > 0
          ? await loadUsageByFeaturePeriodKey({
              deps,
              projectId: input.projectId,
              customerId: input.customerId,
              scopes: usagePeriodPlan.scopes,
            })
          : { usageByFeaturePeriodKey: new Map<string, number>(), error: null }

      if (usageResult.error) {
        deps.logger.error(usageResult.error, {
          context: "error getting customer current-cycle usage",
          projectId: input.projectId,
          customerId: input.customerId,
        })
      }

      const usageByFeaturePeriodKey = usageResult.usageByFeaturePeriodKey

      const output: GetCustomerCurrentAccessOutput = {
        customerId: input.customerId,
        generatedAt: now,
        activePlan: activePlan
          ? {
              subscriptionId: activePlan.id,
              planSlug: activePlan.planSlug,
              status: activePlan.status,
              currentCycleStartAt: activePlan.currentCycleStartAt,
              currentCycleEndAt: activePlan.currentCycleEndAt,
              renewAt: activePlan.renewAt ?? null,
              timezone: activePlan.timezone,
              activePhase: activePlan.phases[0]
                ? {
                    id: activePlan.phases[0].id,
                    planVersionId: activePlan.phases[0].planVersionId,
                    creditLinePolicy: activePlan.phases[0].creditLinePolicy,
                    creditLineAmount: activePlan.phases[0].creditLineAmount ?? null,
                    startAt: activePlan.phases[0].startAt,
                    endAt: activePlan.phases[0].endAt ?? null,
                  }
                : null,
            }
          : null,
        activeSubscriptionCount: activeSubscriptions.length,
        entitlementCount: entitlements.length,
        usageUnavailable: Boolean(usageResult.error),
        usageWindow,
        entitlements: entitlements
          .map((entitlement) => {
            const featurePlanVersion = entitlement.featurePlanVersion
            const feature = featurePlanVersion.feature
            const grantAllowance = sumGrantAllowance(entitlement.grants)
            const limit = featurePlanVersion.limit ?? grantAllowance
            const isUsageEntitlement =
              featurePlanVersion.featureType === "usage" ||
              (featurePlanVersion.meterConfig !== null &&
                featurePlanVersion.meterConfig !== undefined)
            const periodKeys = usagePeriodPlan.periodKeysByEntitlementId.get(entitlement.id) ?? []
            const currentUsage =
              isUsageEntitlement && !usageResult.error
                ? sumUsageForFeaturePeriodKeys({
                    usageByFeaturePeriodKey,
                    featureSlug: feature.slug,
                    periodKeys,
                  })
                : null

            return {
              id: entitlement.id,
              featureSlug: feature.slug,
              featureTitle: feature.title,
              featureType: featurePlanVersion.featureType,
              unitOfMeasure: featurePlanVersion.unitOfMeasure,
              limit,
              currentUsage,
              usagePercent:
                currentUsage !== null && limit !== null && limit > 0
                  ? Math.min(100, (currentUsage / limit) * 100)
                  : null,
              grantCount: entitlement.grants.length,
              grantAllowance,
              subscriptionId: entitlement.subscriptionId ?? null,
              overageStrategy: entitlement.overageStrategy,
            }
          })
          .sort((a, b) => {
            if (
              a.currentUsage !== null &&
              b.currentUsage !== null &&
              b.currentUsage !== a.currentUsage
            ) {
              return b.currentUsage - a.currentUsage
            }

            if (a.currentUsage !== null && b.currentUsage === null) {
              return -1
            }

            if (a.currentUsage === null && b.currentUsage !== null) {
              return 1
            }

            return a.featureSlug.localeCompare(b.featureSlug)
          }),
      }

      return getCustomerCurrentAccessOutputSchema.parse(output)
    })(),
    (error) =>
      new FetchError({
        message: `error getting customer current access: ${error.message}`,
        retry: true,
      })
  )

  if (result.err) {
    deps.logger.error(result.err, {
      context: "error getting customer current access",
      projectId: input.projectId,
      customerId: input.customerId,
    })
    return Err(result.err)
  }

  return Ok(result.val ?? null)
}

async function loadUsageByFeaturePeriodKey({
  deps,
  projectId,
  customerId,
  scopes,
}: {
  deps: GetCustomerCurrentAccessDeps
  projectId: string
  customerId: string
  scopes: UsagePeriodScope[]
}): Promise<{ usageByFeaturePeriodKey: Map<string, number>; error: FetchError | null }> {
  const scopesByPeriodKey = new Map<string, Set<string>>()

  for (const scope of scopes) {
    const featureSlugs = scopesByPeriodKey.get(scope.periodKey) ?? new Set<string>()
    featureSlugs.add(scope.featureSlug)
    scopesByPeriodKey.set(scope.periodKey, featureSlugs)
  }

  const periodGroups = [...scopesByPeriodKey.entries()].map(([periodKey, featureSlugs]) => ({
    featureSlugs,
    periodKey,
  }))
  const results = await Promise.all(
    periodGroups.map(({ periodKey, featureSlugs }) =>
      wrapResult(
        deps.analytics.getFeaturesUsagePeriod({
          project_id: projectId,
          customer_id: customerId,
          period_key: periodKey,
          feature_slugs: [...featureSlugs].sort(),
        }),
        (error) =>
          new FetchError({
            message: error.message,
            retry: true,
            context: {
              url: "tinybird:v1_get_feature_usage_period",
              method: "GET",
              projectId,
              customerId,
              periodKey,
            },
          })
      )
    )
  )

  const failedResult = results.find((result) => result.err)
  if (failedResult?.err) {
    return {
      usageByFeaturePeriodKey: new Map<string, number>(),
      error: failedResult.err,
    }
  }

  const usageByFeaturePeriodKey = new Map<string, number>()

  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    if (!result?.val) {
      continue
    }

    const periodKey = periodGroups[index]?.periodKey
    if (!periodKey) {
      continue
    }

    for (const row of result.val.data ?? []) {
      const usage = row.usage ?? row.value_after ?? 0
      const key = usagePeriodKey(row.feature_slug, periodKey)
      usageByFeaturePeriodKey.set(key, (usageByFeaturePeriodKey.get(key) ?? 0) + usage)
    }
  }

  return { usageByFeaturePeriodKey, error: null }
}

function sumGrantAllowance(grants: Array<{ allowanceUnits: number | null }>): number | null {
  const finiteGrants = grants.filter((grant) => grant.allowanceUnits !== null)

  if (finiteGrants.length === 0) {
    return null
  }

  return finiteGrants.reduce((total, grant) => total + (grant.allowanceUnits ?? 0), 0)
}

function buildUsagePeriodPlan({
  entitlements,
  timestamp,
}: {
  entitlements: ActiveEntitlementRow[]
  timestamp: number
}): { scopes: UsagePeriodScope[]; periodKeysByEntitlementId: Map<string, string[]> } {
  const scopesByKey = new Map<string, UsagePeriodScope>()
  const periodKeysByEntitlementId = new Map<string, string[]>()

  for (const entitlement of entitlements) {
    const featurePlanVersion = entitlement.featurePlanVersion
    const isUsageEntitlement =
      featurePlanVersion.featureType === "usage" ||
      (featurePlanVersion.meterConfig !== null && featurePlanVersion.meterConfig !== undefined)

    if (!isUsageEntitlement) {
      continue
    }

    const resetConfig =
      featurePlanVersion.resetConfig ??
      toGrantResetConfigFromBillingConfig(featurePlanVersion.billingConfig)
    const periodKeys = new Set<string>()

    for (const grant of entitlement.grants) {
      const bucket = computeGrantPeriodBucket(
        {
          cadenceEffectiveAt: entitlement.effectiveAt,
          cadenceExpiresAt: entitlement.expiresAt,
          effectiveAt: grant.effectiveAt,
          expiresAt: grant.expiresAt,
          grantId: grant.id,
          resetConfig,
        },
        timestamp
      )

      if (!bucket) {
        continue
      }

      periodKeys.add(bucket.periodKey)
      const key = usagePeriodKey(featurePlanVersion.feature.slug, bucket.periodKey)
      scopesByKey.set(key, {
        featureSlug: featurePlanVersion.feature.slug,
        periodKey: bucket.periodKey,
      })
    }

    if (periodKeys.size > 0) {
      periodKeysByEntitlementId.set(entitlement.id, [...periodKeys])
    }
  }

  return {
    scopes: [...scopesByKey.values()],
    periodKeysByEntitlementId,
  }
}

function sumUsageForFeaturePeriodKeys({
  usageByFeaturePeriodKey,
  featureSlug,
  periodKeys,
}: {
  usageByFeaturePeriodKey: Map<string, number>
  featureSlug: string
  periodKeys: string[]
}): number {
  return periodKeys.reduce(
    (total, periodKey) =>
      total + (usageByFeaturePeriodKey.get(usagePeriodKey(featureSlug, periodKey)) ?? 0),
    0
  )
}

function usagePeriodKey(featureSlug: string, periodKey: string): string {
  return `${featureSlug}\u0000${periodKey}`
}
