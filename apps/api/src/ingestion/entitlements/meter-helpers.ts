import type { MeterConfig } from "@unprice/services/entitlements"
import { deriveMeterKey } from "@unprice/services/entitlements"
import type { ApplyInput, EntitlementConfigInput, MeterIdentity } from "./contracts"

export function resolveMeterIdentity(entitlement: EntitlementConfigInput): MeterIdentity {
  return {
    customerEntitlementId: entitlement.customerEntitlementId,
    currency: extractCurrencyCodeFromFeatureConfig(entitlement.featureConfig) ?? "USD",
    key: deriveMeterKey(entitlement.meterConfig),
    config: entitlement.meterConfig,
  }
}

export function extractCurrencyCodeFromFeatureConfig(config: unknown): string | null {
  const currencyFromPrice = extractCurrencyCode(config, "price")
  if (currencyFromPrice) {
    return currencyFromPrice
  }

  if (!isRecord(config) || !Array.isArray(config.tiers)) {
    return null
  }

  for (const tier of config.tiers) {
    const currencyFromTier = extractCurrencyCode(tier, "unitPrice")
    if (currencyFromTier) {
      return currencyFromTier
    }
  }

  return null
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

function extractCurrencyCode(input: unknown, priceKey: string): string | null {
  if (!isRecord(input)) {
    return null
  }

  const price = input[priceKey]
  if (!isRecord(price)) {
    return null
  }

  const dinero = price.dinero
  if (!isRecord(dinero)) {
    return null
  }

  const currency = dinero.currency
  if (!isRecord(currency)) {
    return null
  }

  const code = currency.code
  return typeof code === "string" && code.length > 0 ? code : null
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
