import type { MeterConfig } from "@unprice/services/entitlements"
import { describe, expect, it } from "vitest"
import type { ApplyInput, EntitlementConfigInput } from "./contracts"
import {
  extractCurrencyCodeFromFeatureConfig,
  readNumericEventField,
  resolveMeterIdentity,
} from "./meter-helpers"

describe("resolveMeterIdentity", () => {
  it("uses the direct price currency and derived meter key", () => {
    const identity = resolveMeterIdentity(
      createEntitlement({
        featureConfig: priceConfig("EUR"),
      })
    )

    expect(identity).toMatchObject({
      customerEntitlementId: "ce_123",
      currency: "EUR",
      key: "slug=tokens_used|method=sum|field=amount",
    })
  })

  it("falls back to tier pricing currency", () => {
    expect(
      extractCurrencyCodeFromFeatureConfig({
        tiers: [{ unitPrice: priceConfig("GBP").price }],
      })
    ).toBe("GBP")
  })

  it("defaults to USD when pricing has no currency code", () => {
    expect(resolveMeterIdentity(createEntitlement({ featureConfig: {} })).currency).toBe("USD")
  })
})

describe("readNumericEventField", () => {
  it("reads finite numeric values from numbers and strings", () => {
    const meterConfig = createMeterConfig()

    expect(readNumericEventField(meterConfig, createEvent({ amount: 12 }))).toBe(12)
    expect(readNumericEventField(meterConfig, createEvent({ amount: " 12.5 " }))).toBe(12.5)
  })

  it("throws when the aggregation field is missing", () => {
    expect(() =>
      readNumericEventField(createMeterConfig({ aggregationField: undefined }), createEvent())
    ).toThrow("requires an aggregation field")
  })

  it("throws when the aggregation field is not finite numeric", () => {
    expect(() =>
      readNumericEventField(createMeterConfig(), createEvent({ amount: "NaN" }))
    ).toThrow("requires a finite numeric value")
  })
})

function createEntitlement(
  overrides: Partial<EntitlementConfigInput> = {}
): EntitlementConfigInput {
  return {
    creditLinePolicy: "capped",
    customerEntitlementId: "ce_123",
    customerId: "cus_123",
    effectiveAt: 1,
    expiresAt: null,
    featureConfig: priceConfig("USD"),
    featurePlanVersionId: "fpv_123",
    featureSlug: "api_calls",
    featureType: "usage",
    meterConfig: createMeterConfig(),
    overageStrategy: "none",
    projectId: "proj_123",
    resetConfig: null,
    ...overrides,
  } as unknown as EntitlementConfigInput
}

function createMeterConfig(overrides: Partial<MeterConfig> = {}): MeterConfig {
  return {
    aggregationField: "amount",
    aggregationMethod: "sum",
    eventId: "meter_123",
    eventSlug: "tokens_used",
    ...overrides,
  }
}

function createEvent(properties: Record<string, unknown> = {}): ApplyInput["event"] {
  return {
    id: "evt_123",
    slug: "tokens_used",
    timestamp: 1,
    properties,
  }
}

function priceConfig(currencyCode: string) {
  return {
    price: {
      dinero: {
        amount: 100,
        currency: { code: currencyCode, base: 10, exponent: 2 },
        scale: 2,
      },
      displayAmount: "1.00",
    },
    usageMode: "unit",
  }
}
