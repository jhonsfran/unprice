import { describe, expect, it, vi } from "vitest"
import type { IngestionEntitlement } from "./entitlement-context"
import { IngestionEntitlementRouter } from "./entitlement-routing"
import type { IngestionQueueMessage } from "./message"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("IngestionEntitlementRouter", () => {
  it("returns NO_MATCHING_ENTITLEMENT when sync feature slug has no candidate", () => {
    const router = new IngestionEntitlementRouter({ logger: createLogger() })
    const result = router.resolveSyncFeatureEntitlements({
      candidateEntitlements: [createEntitlement({ featureSlug: "other_feature" })],
      featureSlug: "api_calls",
      message: createMessage(),
    })

    expect(result).toEqual({ err: "NO_MATCHING_ENTITLEMENT" })
  })

  it("rejects duplicate active sync feature entitlements and logs the conflict", () => {
    const logger = createLogger()
    const router = new IngestionEntitlementRouter({ logger })
    const result = router.resolveSyncFeatureEntitlements({
      candidateEntitlements: [
        createEntitlement({ customerEntitlementId: "ce_first" }),
        createEntitlement({ customerEntitlementId: "ce_second" }),
      ],
      featureSlug: "api_calls",
      message: createMessage(),
    })

    expect(result).toEqual({ err: "INVALID_ENTITLEMENT_CONFIGURATION" })
    expect(logger.error).toHaveBeenCalledWith(
      "multiple active entitlements matched ingestion event",
      {
        projectId: "proj_123",
        customerId: "cus_123",
        eventId: "evt_123",
        eventSlug: "usage.recorded",
        customerEntitlementIds: ["ce_first", "ce_second"],
      }
    )
  })

  it("returns INVALID_AGGREGATION_PROPERTIES when no matching usage meter can read the payload", () => {
    const router = new IngestionEntitlementRouter({ logger: createLogger() })
    const result = router.resolveProcessableEntitlements({
      candidateEntitlements: [createEntitlement()],
      message: createMessage({ properties: { other: 1 } }),
    })

    expect(result).toEqual({ err: "INVALID_AGGREGATION_PROPERTIES" })
  })

  it("returns processable async entitlements and warns when fanout exceeds the threshold", () => {
    const logger = createLogger()
    const router = new IngestionEntitlementRouter({
      fanoutWarningThreshold: 1,
      logger,
    })
    const result = router.resolveProcessableEntitlements({
      candidateEntitlements: [
        createEntitlement({ customerEntitlementId: "ce_tokens" }),
        createEntitlement({ customerEntitlementId: "ce_requests" }),
      ],
      message: createMessage({ properties: { amount: 42 } }),
    })

    expect(result.val?.map((entitlement) => entitlement.customerEntitlementId)).toEqual([
      "ce_tokens",
      "ce_requests",
    ])
    expect(logger.warn).toHaveBeenCalledWith("high ingestion entitlement fanout", {
      projectId: "proj_123",
      customerId: "cus_123",
      eventId: "evt_123",
      eventSlug: "usage.recorded",
      matched_entitlements_per_event: 2,
      fanout_warning_threshold: 1,
      customerEntitlementIds: ["ce_tokens", "ce_requests"],
    })
  })

  it("returns UNROUTABLE_EVENT when candidates are inactive or use a different event slug", () => {
    const router = new IngestionEntitlementRouter({ logger: createLogger() })
    const result = router.resolveProcessableEntitlements({
      candidateEntitlements: [
        createEntitlement({
          customerEntitlementId: "ce_inactive",
          expiresAt: TEST_NOW - 1,
        }),
        createEntitlement({
          customerEntitlementId: "ce_different_event",
          meterConfig: {
            eventId: "evt_other",
            eventSlug: "other.event",
            aggregationMethod: "sum",
            aggregationField: "amount",
          },
        }),
      ],
      message: createMessage(),
    })

    expect(result).toEqual({ err: "UNROUTABLE_EVENT" })
  })
})

function createLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  }
}

function createMessage(overrides: Partial<IngestionQueueMessage> = {}): IngestionQueueMessage {
  return {
    version: 1,
    workspaceId: "ws_123",
    projectId: "proj_123",
    customerId: "cus_123",
    requestId: "req_123",
    receivedAt: TEST_NOW,
    idempotencyKey: "idem_123",
    id: "evt_123",
    slug: "usage.recorded",
    timestamp: TEST_NOW,
    properties: { amount: 1 },
    source: {
      environment: "test",
      apiKeyId: "key_123",
      sourceType: "api_key",
      sourceId: "key_123",
      sourceName: null,
    },
    ...overrides,
  }
}

function createEntitlement(overrides: Partial<IngestionEntitlement> = {}): IngestionEntitlement {
  return {
    billingPeriods: [],
    creditLinePolicy: "capped",
    customerEntitlementId: "ce_123",
    customerId: "cus_123",
    effectiveAt: TEST_NOW - 1_000,
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
      eventId: "evt_usage",
      eventSlug: "usage.recorded",
      aggregationMethod: "sum",
      aggregationField: "amount",
    },
    overageStrategy: "none",
    projectId: "proj_123",
    resetConfig: null,
    subscriptionItemId: null,
    ...overrides,
  }
}
