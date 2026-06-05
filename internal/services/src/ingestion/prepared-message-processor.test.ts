import { describe, expect, it, vi } from "vitest"
import type { IngestionEntitlement } from "./entitlement-context"
import { IngestionEntitlementRouter } from "./entitlement-routing"
import type { EntitlementWindowApplier } from "./entitlement-window-applier"
import { getMessageOutcomeKey } from "./fanout-outcomes"
import type { IngestionQueueMessage } from "./message"
import { IngestionMessageOutcomes } from "./message-outcomes"
import { IngestionPreparedMessageProcessor } from "./prepared-message-processor"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("IngestionPreparedMessageProcessor", () => {
  it("rejects messages with a prepared context rejection without applying entitlements", async () => {
    const applyBatch = vi.fn()
    const logger = createLogger()
    const processor = createProcessor({ applyBatch, logger })
    const messages = [createMessage({ id: "evt_1" }), createMessage({ id: "evt_2" })]

    const outcomes = await processor.process({
      candidateEntitlements: [createEntitlement()],
      customerId: "cus_123",
      projectId: "proj_123",
      messages,
      rejectionReason: "NO_MATCHING_ENTITLEMENT",
    })

    expect(outcomes).toEqual(
      messages.map((message) => ({
        message,
        outcome: {
          state: "rejected",
          rejectionReason: "NO_MATCHING_ENTITLEMENT",
        },
      }))
    )
    expect(applyBatch).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })

  it("rejects invalid aggregation payloads before applying entitlements", async () => {
    const applyBatch = vi.fn()
    const processor = createProcessor({ applyBatch })
    const message = createMessage({ properties: { other: 1 } })

    const outcomes = await processor.process({
      candidateEntitlements: [createEntitlement()],
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [message],
    })

    expect(outcomes).toEqual([
      {
        message,
        outcome: {
          state: "rejected",
          rejectionReason: "INVALID_AGGREGATION_PROPERTIES",
        },
      },
    ])
    expect(applyBatch).not.toHaveBeenCalled()
  })

  it("applies entitlement windows in batches per entitlement", async () => {
    const applyBatch = vi.fn().mockImplementation(
      (input: {
        messageOutcomeKeys: ReadonlyMap<IngestionQueueMessage, string>
        messages: IngestionQueueMessage[]
      }) =>
        Promise.resolve(
          input.messages.map((message) => ({
            allowed: true,
            correlationKey: getMessageOutcomeKey(message, input.messageOutcomeKeys),
          }))
        )
    )
    const processor = createProcessor({ applyBatch, entitlementApplyBatchSize: 2 })
    const messages = [
      createMessage({ id: "evt_1" }),
      createMessage({ id: "evt_2" }),
      createMessage({ id: "evt_3" }),
    ]

    const outcomes = await processor.process({
      candidateEntitlements: [createEntitlement()],
      customerId: "cus_123",
      projectId: "proj_123",
      messages,
    })

    expect(outcomes).toEqual(
      messages.map((message) => ({ message, outcome: { state: "processed" } }))
    )
    expect(applyBatch).toHaveBeenCalledTimes(2)
    expect(applyBatch.mock.calls.map(([input]) => input.messages.length)).toEqual([2, 1])
  })

  it("records concrete apply denials as rejected outcomes", async () => {
    const applyBatch = vi.fn().mockImplementation(
      (input: {
        messageOutcomeKeys: ReadonlyMap<IngestionQueueMessage, string>
        messages: IngestionQueueMessage[]
      }) =>
        Promise.resolve(
          input.messages.map((message) => ({
            allowed: false,
            correlationKey: getMessageOutcomeKey(message, input.messageOutcomeKeys),
            deniedReason: "WALLET_EMPTY",
          }))
        )
    )
    const logger = createLogger()
    const processor = createProcessor({ applyBatch, logger })
    const message = createMessage()

    const outcomes = await processor.process({
      candidateEntitlements: [createEntitlement()],
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [message],
    })

    expect(outcomes).toEqual([
      {
        message,
        outcome: {
          state: "rejected",
          rejectionReason: "WALLET_EMPTY",
        },
      },
    ])
    expect(logger.warn).toHaveBeenCalledWith(
      "raw ingestion message rejected",
      expect.objectContaining({
        eventId: message.id,
        rejectionReason: "WALLET_EMPTY",
      })
    )
  })
})

function createProcessor(
  overrides: {
    applyBatch?: ReturnType<typeof vi.fn>
    entitlementApplyBatchSize?: number
    logger?: ReturnType<typeof createLogger>
  } = {}
) {
  const logger = overrides.logger ?? createLogger()
  return new IngestionPreparedMessageProcessor({
    entitlementApplyBatchSize: overrides.entitlementApplyBatchSize,
    entitlementRouter: new IngestionEntitlementRouter({ logger }),
    entitlementWindowApplier: {
      applyBatch: overrides.applyBatch ?? vi.fn().mockResolvedValue([]),
    } as unknown as EntitlementWindowApplier,
    logger,
    messageOutcomes: new IngestionMessageOutcomes({ logger, now: () => TEST_NOW }),
  })
}

function createLogger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
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
    ...overrides,
  }
}
