import { describe, expect, it } from "vitest"
import {
  buildIngestionWindowName,
  filterIngestionEntitlementsWithValidAggregationPayload,
  isIngestionEntitlementActiveAt,
} from "./message"
import type { IngestionEntitlement } from "./service"

describe("ingestion entitlement message helpers", () => {
  const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)

  const entitlement = (overrides: Partial<IngestionEntitlement> = {}): IngestionEntitlement => ({
    creditLinePolicy: "capped",
    customerEntitlementId: "ce_123",
    customerId: "cus_123",
    effectiveAt: Date.UTC(2026, 2, 1),
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
    grants: [],
    meterConfig: {
      eventId: "evt_type",
      eventSlug: "usage.recorded",
      aggregationMethod: "sum",
      aggregationField: "amount",
    },
    overageStrategy: "none",
    projectId: "proj_123",
    resetConfig: null,
    ...overrides,
  })

  it("routes ingestion windows by customer entitlement id", () => {
    expect(
      buildIngestionWindowName({
        appEnv: "test",
        projectId: "proj_123",
        customerId: "cus_123",
        customerEntitlementId: "ce_123",
      })
    ).toBe("test:proj_123:cus_123:ce_123")
  })

  it("rejects events outside the entitlement window", () => {
    const state = entitlement({
      effectiveAt: timestamp - 100,
      expiresAt: timestamp + 100,
    })

    expect(isIngestionEntitlementActiveAt(state, timestamp - 101)).toBe(false)
    expect(isIngestionEntitlementActiveAt(state, timestamp + 100)).toBe(false)
    expect(isIngestionEntitlementActiveAt(state, timestamp)).toBe(true)
  })

  it("keeps only entitlements with valid aggregation payloads", () => {
    const count = entitlement({
      customerEntitlementId: "ce_count",
      meterConfig: {
        eventId: "evt_count",
        eventSlug: "usage.recorded",
        aggregationMethod: "count",
      },
    })
    const validSum = entitlement({ customerEntitlementId: "ce_sum" })
    const invalidSum = entitlement({ customerEntitlementId: "ce_invalid" })

    expect(
      filterIngestionEntitlementsWithValidAggregationPayload({
        event: {
          properties: { amount: "12" },
        },
        entitlements: [count, validSum, invalidSum],
      }).map((candidate) => candidate.customerEntitlementId)
    ).toEqual(["ce_count", "ce_sum", "ce_invalid"])

    expect(
      filterIngestionEntitlementsWithValidAggregationPayload({
        event: {
          properties: { amount: "not-a-number" },
        },
        entitlements: [count, validSum],
      }).map((candidate) => candidate.customerEntitlementId)
    ).toEqual(["ce_count"])
  })
})
