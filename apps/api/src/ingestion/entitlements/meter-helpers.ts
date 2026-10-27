import type { MeterConfig } from "@unprice/services/entitlements"
import {
  computeGrantPeriodBucket,
  deriveMeterKey,
  extractCurrencyCodeFromFeatureConfig,
} from "@unprice/services/entitlements"
import type { ApplyInput, EntitlementConfigInput, MeterIdentity } from "./contracts"
import type { EntitlementWindowStateOps } from "./ports"

export { extractCurrencyCodeFromFeatureConfig } from "@unprice/services/entitlements"

export function resolveMeterIdentity(entitlement: EntitlementConfigInput): MeterIdentity {
  return {
    customerEntitlementId: entitlement.customerEntitlementId,
    currency: extractCurrencyCodeFromFeatureConfig(entitlement.featureConfig) ?? "USD",
    key: deriveMeterKey(entitlement.meterConfig),
    config: entitlement.meterConfig,
  }
}

export function readNumericEventField(
  meterConfig: MeterConfig,
  event: ApplyInput["event"]
): number {
  const field = meterConfig.aggregationField

  if (!field) {
    throw new Error(`Meter ${meterConfig.eventId} requires an aggregation field`)
  }

  const rawValue = event.properties[field]
  const numericValue = parseFiniteNumericValue(rawValue)

  if (numericValue === null) {
    throw new Error(
      `Meter ${meterConfig.eventId} requires a finite numeric value at properties.${field}`
    )
  }

  return numericValue
}

function parseFiniteNumericValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== "string") {
    return null
  }

  const trimmedValue = value.trim()
  if (trimmedValue.length === 0) {
    return null
  }

  const parsedValue = Number(trimmedValue)
  return Number.isFinite(parsedValue) ? parsedValue : null
}

export function resolveMeterStateKey(params: {
  entitlement: EntitlementConfigInput
  timestamp: number
}): string {
  const { entitlement, timestamp } = params
  const meterKey = deriveMeterKey(entitlement.meterConfig)
  if (!entitlement.resetConfig || entitlement.resetConfig.resetInterval === "onetime") {
    return meterKey
  }
  const period = computeGrantPeriodBucket(
    {
      grantId: entitlement.customerEntitlementId,
      effectiveAt: entitlement.effectiveAt,
      expiresAt: entitlement.expiresAt,
      resetConfig: entitlement.resetConfig,
    },
    timestamp
  )
  if (!period) throw new Error("Unable to resolve meter aggregation period")
  return `${meterKey}|period=${encodeURIComponent(period.periodKey)}`
}

export function readEventMeterState(params: {
  createdAt: number
  entitlement: EntitlementConfigInput
  store: Pick<EntitlementWindowStateOps, "readMeterStateDraft">
  timestamp: number
}) {
  const { createdAt, entitlement, store, timestamp } = params
  const key = resolveMeterStateKey({ entitlement, timestamp })
  const scoped = store.readMeterStateDraft(key, createdAt)
  if (scoped.exists || !entitlement.resetConfig) return scoped
  const legacy = store.readMeterStateDraft(deriveMeterKey(entitlement.meterConfig), createdAt)
  if (!legacy.exists) return scoped
  const period = computeGrantPeriodBucket(
    {
      grantId: entitlement.customerEntitlementId,
      effectiveAt: entitlement.effectiveAt,
      expiresAt: entitlement.expiresAt,
      resetConfig: entitlement.resetConfig,
    },
    timestamp
  )
  if (!period || legacy.updatedAt === null || period.start <= legacy.updatedAt) {
    throw new Error(
      "Legacy meter state overlaps this reset period. Reconcile historical usage before recording new events in this period."
    )
  }
  return scoped
}
