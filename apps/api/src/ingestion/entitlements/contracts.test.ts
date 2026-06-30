import { describe, expect, it } from "vitest"
import { activeGrantSchema, enforcementStateInputSchema } from "./contracts"

const enrichedGrant = {
  allowanceUnits: 100,
  cadenceEffectiveAt: 1_781_503_200_000,
  cadenceExpiresAt: null,
  currencyCode: "USD",
  effectiveAt: 1_781_503_200_000,
  expiresAt: null,
  grantId: "grant_123",
  priority: 10,
  resetConfig: null,
}

const entitlement = {
  billingPeriods: [],
  creditLinePolicy: "capped",
  customerEntitlementId: "ce_123",
  customerId: "cus_123",
  effectiveAt: 1_781_503_200_000,
  expiresAt: null,
  featureConfig: {
    usageMode: "unit",
    price: {
      dinero: {
        amount: 0,
        currency: { code: "USD", base: 10, exponent: 2 },
        scale: 2,
      },
      displayAmount: "0.00",
    },
  },
  featurePlanVersionId: "fpv_123",
  featureSlug: "api_calls",
  featureType: "usage",
  meterConfig: {
    eventId: "evt_usage",
    eventSlug: "usage.recorded",
    aggregationMethod: "sum",
    aggregationField: "amount",
  },
  overageStrategy: "none",
  projectId: "proj_123",
  resetConfig: null,
  subscriptionItemId: null,
}

describe("EntitlementWindowDO contracts", () => {
  it("retains enriched grant fields", () => {
    expect(activeGrantSchema.parse(enrichedGrant)).toEqual(enrichedGrant)
  })

  it("rejects legacy grants without cadence, currency, and reset fields", () => {
    const result = activeGrantSchema.safeParse({
      allowanceUnits: 100,
      effectiveAt: 1_781_503_200_000,
      expiresAt: null,
      grantId: "grant_123",
      priority: 10,
    })

    expect(result.success).toBe(false)
  })

  it("requires enforcement input but allows an empty grant array", () => {
    expect(
      enforcementStateInputSchema.parse({
        entitlement,
        grants: [],
        now: 1_781_503_200_000,
      })
    ).toMatchObject({ grants: [] })
  })
})
