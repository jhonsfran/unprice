import { type BillingConfig, type ResetConfig, calculateCycleWindow } from "@unprice/db/validators"

export type GrantConsumptionGrant = {
  allowanceUnits: number | null
  cadenceEffectiveAt?: number
  cadenceExpiresAt?: number | null
  effectiveAt: number
  expiresAt: number | null
  grantId: string
  priority: number
  resetConfig?: ResetConfig | null
}

export function toGrantResetConfigFromBillingConfig(billingConfig: BillingConfig): ResetConfig {
  return {
    name: billingConfig.name,
    resetInterval: billingConfig.billingInterval,
    resetIntervalCount: billingConfig.billingIntervalCount,
    resetAnchor: "dayOfCreation",
    planType: billingConfig.planType,
  }
}

export function computeGrantPeriodBucket(
  grant: Pick<
    GrantConsumptionGrant,
    | "cadenceEffectiveAt"
    | "cadenceExpiresAt"
    | "effectiveAt"
    | "expiresAt"
    | "grantId"
    | "resetConfig"
  >,
  timestamp: number
): { bucketKey: string; end: number; periodKey: string; start: number } | null {
  const effectiveStartDate = grant.cadenceEffectiveAt ?? grant.effectiveAt

  const config = grant.resetConfig
    ? {
        name: grant.resetConfig.name,
        interval: grant.resetConfig.resetInterval,
        intervalCount: grant.resetConfig.resetIntervalCount,
        anchor: grant.resetConfig.resetAnchor ?? "dayOfCreation",
        planType: grant.resetConfig.planType,
      }
    : {
        name: "ingestion",
        interval: "onetime" as const,
        intervalCount: 1,
        anchor: "dayOfCreation" as const,
        planType: "onetime" as const,
      }

  const cycle = calculateCycleWindow({
    now: timestamp,
    effectiveStartDate,
    effectiveEndDate: grant.cadenceExpiresAt ?? grant.expiresAt,
    trialEndsAt: null,
    config,
  })

  if (!cycle) return null

  const periodKey = `${config.interval}:${cycle.start}`
  return {
    bucketKey: `${grant.grantId}:${periodKey}`,
    periodKey,
    start: cycle.start,
    end: Number.isFinite(cycle.end) ? cycle.end : Number.MAX_SAFE_INTEGER,
  }
}
