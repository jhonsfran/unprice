import type { MeterConfig } from "@unprice/services/entitlements"
import {
  deriveMeterKey,
  extractCurrencyCodeFromFeatureConfig,
} from "@unprice/services/entitlements"
import type { ApplyInput, EntitlementConfigInput, MeterIdentity } from "./contracts"

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
