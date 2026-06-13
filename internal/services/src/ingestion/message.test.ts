import { describe, expect, it } from "vitest"
import type { IngestionEntitlement } from "./entitlement-context"
import {
  buildIngestionWindowName,
  filterIngestionEntitlementsWithValidAggregationPayload,
  ingestionQueueMessageSchema,
  isIngestionEntitlementActiveAt,
} from "./message"

describe("ingestion entitlement message helpers", () => {
  const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)

  const entitlement = (overrides: Partial<IngestionEntitlement> = {}): IngestionEntitlement => ({
    billingPeriods: [],
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
    subscriptionItemId: null,
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

  it("requires source identity on ingestion queue messages", () => {
    const message = {
      version: 1,
      workspaceId: "ws_1",
      projectId: "proj_1",
      customerId: "cus_1",
      requestId: "req_1",
      receivedAt: 1_000,
      idempotencyKey: "idem_1",
      id: "evt_1",
      slug: "tokens.used",
      timestamp: 900,
      properties: { tokens: 42 },
      source: {
        environment: "development",
        apiKeyId: "key_1",
        sourceType: "api_key",
        sourceId: "key_1",
        sourceName: null,
      },
    }

    expect(ingestionQueueMessageSchema.parse(message)).toMatchObject({
      workspaceId: "ws_1",
      source: { sourceType: "api_key", sourceId: "key_1" },
    })

    const { workspaceId: _workspaceId, ...messageWithoutWorkspace } = message
    const { source: _source, ...messageWithoutSource } = message

    expect(() => ingestionQueueMessageSchema.parse(messageWithoutWorkspace)).toThrow()
    expect(() => ingestionQueueMessageSchema.parse(messageWithoutSource)).toThrow()
  })

  it("accepts optional raw storage pointers with non-empty bucket and object keys", () => {
    const message = {
      version: 1,
      workspaceId: "ws_1",
      projectId: "proj_1",
      customerId: "cus_1",
      requestId: "req_1",
      receivedAt: 1_000,
      idempotencyKey: "idem_1",
      id: "evt_1",
      slug: "tokens.used",
      timestamp: 900,
      properties: { tokens: 42 },
      source: {
        environment: "development",
        apiKeyId: "key_1",
        sourceType: "api_key",
        sourceId: "key_1",
        sourceName: null,
      },
      rawStorage: {
        bucketName: "raw-events",
        objectKey: "ingestion/raw/development/proj_1/cus_1/idem_1/evt_1.json",
      },
    }

    expect(ingestionQueueMessageSchema.parse(message).rawStorage).toEqual(message.rawStorage)
    expect(() =>
      ingestionQueueMessageSchema.parse({
        ...message,
        rawStorage: { bucketName: "", objectKey: message.rawStorage.objectKey },
      })
    ).toThrow()
    expect(() =>
      ingestionQueueMessageSchema.parse({
        ...message,
        rawStorage: { bucketName: message.rawStorage.bucketName, objectKey: "" },
      })
    ).toThrow()
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

  it("keeps multiple meters from one event when each aggregation key is present", () => {
    const candidates = [
      entitlement({
        customerEntitlementId: "ce_count",
        featureSlug: "requests",
        meterConfig: {
          eventId: "evt_usage",
          eventSlug: "usage.recorded",
          aggregationMethod: "count",
        },
      }),
      entitlement({
        customerEntitlementId: "ce_sum",
        featureSlug: "tokens",
        meterConfig: {
          eventId: "evt_usage",
          eventSlug: "usage.recorded",
          aggregationMethod: "sum",
          aggregationField: "tokens",
        },
      }),
      entitlement({
        customerEntitlementId: "ce_max",
        featureSlug: "peak-memory",
        meterConfig: {
          eventId: "evt_usage",
          eventSlug: "usage.recorded",
          aggregationMethod: "max",
          aggregationField: "memoryMb",
        },
      }),
      entitlement({
        customerEntitlementId: "ce_latest",
        featureSlug: "seat-count",
        meterConfig: {
          eventId: "evt_usage",
          eventSlug: "usage.recorded",
          aggregationMethod: "latest",
          aggregationField: "seats",
        },
      }),
    ]

    expect(
      filterIngestionEntitlementsWithValidAggregationPayload({
        event: {
          properties: {
            memoryMb: 512,
            seats: "7",
            tokens: "42.5",
          },
        },
        entitlements: candidates,
      }).map((candidate) => candidate.customerEntitlementId)
    ).toEqual(["ce_count", "ce_sum", "ce_max", "ce_latest"])
  })
})
