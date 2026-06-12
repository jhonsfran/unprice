import { describe, expect, it, vi } from "vitest"
import { INGESTION_MAX_EVENT_AGE_MS } from "../entitlements"
import { IngestionCustomerGroupProcessor } from "./customer-group-processor"
import type { FanoutMessageOutcome } from "./fanout-outcomes"
import type { IngestionQueueMessage } from "./message"
import { IngestionMessageOutcomes } from "./message-outcomes"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("IngestionCustomerGroupProcessor", () => {
  it("reports stale messages and returns ack results without loading context", async () => {
    const prepareCustomerMessageGroup = vi.fn()
    const preparedProcess = vi.fn()
    const enqueueOutcomes = vi.fn().mockResolvedValue(undefined)
    const processor = createProcessor({
      enqueueOutcomes,
      preparedProcess,
      prepareCustomerMessageGroup,
    })
    const staleMessage = createMessage({
      id: "evt_stale",
      timestamp: TEST_NOW - INGESTION_MAX_EVENT_AGE_MS - 1,
    })

    const result = await processor.processCustomerGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [staleMessage],
    })

    expect(result).toEqual([
      {
        message: staleMessage,
        disposition: {
          action: "ack",
        },
      },
    ])
    expect(prepareCustomerMessageGroup).not.toHaveBeenCalled()
    expect(preparedProcess).not.toHaveBeenCalled()
    expect(enqueueOutcomes).toHaveBeenCalledWith({
      customerId: "cus_123",
      projectId: "proj_123",
      outcomes: [
        {
          message: staleMessage,
          outcome: {
            state: "rejected",
            rejectionReason: "EVENT_TOO_OLD",
          },
        },
      ],
    })
  })

  it("reports customer-not-found outcomes without running entitlement applies", async () => {
    const freshMessage = createMessage()
    const preparedProcess = vi.fn()
    const enqueueOutcomes = vi.fn().mockResolvedValue(undefined)
    const processor = createProcessor({
      enqueueOutcomes,
      preparedProcess,
      preparedGroup: {
        candidateEntitlements: [],
        messages: [freshMessage],
        rejectionReason: "CUSTOMER_NOT_FOUND",
      },
    })

    const result = await processor.processCustomerGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [freshMessage],
    })

    expect(result[0]?.disposition.action).toBe("ack")
    expect(preparedProcess).not.toHaveBeenCalled()
    expect(enqueueOutcomes).toHaveBeenCalledWith({
      customerId: "cus_123",
      projectId: "proj_123",
      outcomes: [
        {
          message: freshMessage,
          outcome: {
            state: "rejected",
            rejectionReason: "CUSTOMER_NOT_FOUND",
          },
        },
      ],
    })
  })

  it("processes fresh messages in timestamp order and reports group stats", async () => {
    const olderMessage = createMessage({
      id: "evt_older",
      idempotencyKey: "idem_older",
      timestamp: TEST_NOW - 10,
    })
    const newerMessage = createMessage({
      id: "evt_newer",
      idempotencyKey: "idem_newer",
      timestamp: TEST_NOW,
    })
    const logger = createLogger()
    const freshOutcomes: FanoutMessageOutcome[] = [
      {
        message: olderMessage,
        outcome: { state: "processed" },
        meterFacts: [{ id: "fact_1" } as never],
      },
      {
        message: newerMessage,
        outcome: { state: "processed" },
      },
    ]
    const preparedProcess = vi.fn().mockResolvedValue(freshOutcomes)
    const enqueueOutcomes = vi.fn().mockResolvedValue(undefined)
    const processor = createProcessor({
      enqueueOutcomes,
      logger,
      preparedGroup: {
        candidateEntitlements: [{ customerEntitlementId: "ce_123" } as never],
        messages: [olderMessage, newerMessage],
      },
      preparedProcess,
    })

    const result = await processor.processCustomerGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [newerMessage, olderMessage],
    })

    expect(preparedProcess).toHaveBeenCalledWith({
      candidateEntitlements: [{ customerEntitlementId: "ce_123" }],
      customerId: "cus_123",
      messages: [olderMessage, newerMessage],
      projectId: "proj_123",
      rejectionReason: undefined,
    })
    expect(enqueueOutcomes).toHaveBeenCalledWith({
      customerId: "cus_123",
      projectId: "proj_123",
      outcomes: freshOutcomes,
    })
    expect(result.map((item) => item.message.id)).toEqual(["evt_older", "evt_newer"])
    expect(logger.info).toHaveBeenCalledWith(
      "raw ingestion customer group",
      expect.objectContaining({
        raw_event_count: 2,
        fresh_event_count: 2,
        reporting_audit_record_count: 2,
        reporting_meter_fact_count: 1,
      })
    )
  })

  it("reloads prepared context after subscription catch-up changes lifecycle state", async () => {
    const message = createMessage()
    const firstPreparedGroup = {
      candidateEntitlements: [
        {
          customerEntitlementId: "ce_before",
          featureType: "usage",
          meterConfig: { eventSlug: "usage.recorded" },
          billingPeriods: [],
          subscriptionId: "sub_123",
        } as never,
      ],
      messages: [message],
    }
    const secondPreparedGroup = {
      candidateEntitlements: [{ customerEntitlementId: "ce_after" } as never],
      messages: [message],
    }
    const prepareCustomerMessageGroup = vi
      .fn()
      .mockResolvedValueOnce(firstPreparedGroup)
      .mockResolvedValueOnce(secondPreparedGroup)
    const catchUpForPreparedGroup = vi.fn().mockResolvedValue({
      changed: true,
      caughtUpSubscriptionIds: ["sub_123"],
    })
    const preparedProcess = vi.fn().mockResolvedValue([
      {
        message,
        outcome: { state: "processed" },
      },
    ])

    const processor = createProcessor({
      preparedProcess,
      prepareCustomerMessageGroup,
      subscriptionCatchUp: { catchUpForPreparedGroup },
    })

    await processor.processCustomerGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [message],
    })

    expect(catchUpForPreparedGroup).toHaveBeenCalledWith({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [message],
      candidateEntitlements: firstPreparedGroup.candidateEntitlements,
    })
    expect(prepareCustomerMessageGroup).toHaveBeenCalledTimes(2)
    expect(preparedProcess).toHaveBeenCalledWith({
      candidateEntitlements: secondPreparedGroup.candidateEntitlements,
      customerId: "cus_123",
      messages: [message],
      projectId: "proj_123",
      rejectionReason: undefined,
    })
  })

  it("returns retry results for the sorted group when processing fails", async () => {
    const logger = createLogger()
    const olderMessage = createMessage({
      id: "evt_older",
      idempotencyKey: "idem_older",
      timestamp: TEST_NOW - 10,
    })
    const newerMessage = createMessage({
      id: "evt_newer",
      idempotencyKey: "idem_newer",
      timestamp: TEST_NOW,
    })
    const processor = createProcessor({
      logger,
      preparedProcess: vi.fn().mockRejectedValue(new Error("apply failed")),
      preparedGroup: {
        candidateEntitlements: [],
        messages: [olderMessage, newerMessage],
      },
    })

    const result = await processor.processCustomerGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [newerMessage, olderMessage],
    })

    expect(result).toEqual([
      {
        message: olderMessage,
        disposition: {
          action: "retry",
          retryAfterSeconds: undefined,
        },
      },
      {
        message: newerMessage,
        disposition: {
          action: "retry",
          retryAfterSeconds: undefined,
        },
      },
    ])
    expect(logger.error).toHaveBeenCalledWith(
      "raw ingestion queue processing failed",
      expect.objectContaining({
        customerId: "cus_123",
        projectId: "proj_123",
      })
    )
  })
})

function createProcessor(
  overrides: {
    enqueueOutcomes?: ReturnType<typeof vi.fn>
    logger?: ReturnType<typeof createLogger>
    preparedGroup?:
      | {
          candidateEntitlements: []
          messages: IngestionQueueMessage[]
          rejectionReason?: "CUSTOMER_NOT_FOUND"
        }
      | {
          candidateEntitlements: never[]
          messages: IngestionQueueMessage[]
          rejectionReason?: undefined
        }
    preparedProcess?: ReturnType<typeof vi.fn>
    prepareCustomerMessageGroup?: ReturnType<typeof vi.fn>
    subscriptionCatchUp?: {
      catchUpForPreparedGroup: ReturnType<typeof vi.fn>
    }
  } = {}
) {
  const logger = overrides.logger ?? createLogger()
  const preparedGroup = overrides.preparedGroup ?? {
    candidateEntitlements: [],
    messages: [createMessage()],
  }

  return new IngestionCustomerGroupProcessor({
    entitlementContext: {
      prepareCustomerMessageGroup:
        overrides.prepareCustomerMessageGroup ?? vi.fn().mockResolvedValue(preparedGroup),
    },
    logger,
    messageOutcomes: new IngestionMessageOutcomes({ logger, now: () => TEST_NOW }),
    preparedMessageProcessor: {
      process:
        overrides.preparedProcess ??
        vi.fn().mockResolvedValue(
          preparedGroup.messages.map((message) => ({
            message,
            outcome: { state: "processed" },
          }))
        ),
    },
    reportingDispatcher: {
      enqueueOutcomes: overrides.enqueueOutcomes ?? vi.fn().mockResolvedValue(undefined),
    },
    subscriptionCatchUp: overrides.subscriptionCatchUp,
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
