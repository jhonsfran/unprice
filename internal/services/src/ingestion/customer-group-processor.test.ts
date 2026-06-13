import { describe, expect, it, vi } from "vitest"
import { INGESTION_MAX_EVENT_AGE_MS } from "../entitlements"
import { IngestionCustomerGroupProcessor } from "./customer-group-processor"
import { markRawProcessingFailureTestRequestId } from "./failure-injection"
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

  it("logs and retries unreported messages when normal outcome reporting enqueue fails", async () => {
    const logger = createLogger()
    const reportingError = new Error("reporting down")
    const message = createMessage()
    const enqueueOutcomes = vi.fn().mockRejectedValue(reportingError)
    const processor = createProcessor({
      enqueueOutcomes,
      logger,
      preparedGroup: {
        candidateEntitlements: [],
        messages: [message],
      },
      preparedProcess: vi.fn().mockResolvedValue([
        {
          message,
          outcome: { state: "processed" },
        },
      ]),
    })

    const result = await processor.processCustomerGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [message],
    })

    expect(result).toEqual([
      {
        message,
        disposition: {
          action: "retry",
          retryAfterSeconds: undefined,
        },
      },
    ])
    expect(logger.error).toHaveBeenCalledWith("raw ingestion reporting enqueue failed", {
      customerId: "cus_123",
      projectId: "proj_123",
      error: reportingError,
    })
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

  it("reports unexpected raw processing failures as replayable failed outcomes and acks after enqueue", async () => {
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
    const enqueueOutcomes = vi.fn().mockResolvedValue(undefined)
    const processor = createProcessor({
      enqueueOutcomes,
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
          action: "ack",
        },
      },
      {
        message: newerMessage,
        disposition: {
          action: "ack",
        },
      },
    ])
    expect(enqueueOutcomes).toHaveBeenCalledWith({
      customerId: "cus_123",
      projectId: "proj_123",
      outcomes: [
        {
          message: olderMessage,
          outcome: {
            state: "failed",
            failureStage: "rating_fact",
            failureReason: "raw_ingestion_queue_processing_failed",
            replayable: true,
          },
        },
        {
          message: newerMessage,
          outcome: {
            state: "failed",
            failureStage: "rating_fact",
            failureReason: "raw_ingestion_queue_processing_failed",
            replayable: true,
          },
        },
      ],
    })
    expect(logger.error).toHaveBeenCalledWith(
      "raw ingestion queue processing failed",
      expect.objectContaining({
        customerId: "cus_123",
        projectId: "proj_123",
      })
    )
  })

  it("reports enabled raw processing failure test markers as replayable failed outcomes", async () => {
    const logger = createLogger()
    const message = createMessage({
      requestId: markRawProcessingFailureTestRequestId("req_123"),
    })
    const enqueueOutcomes = vi.fn().mockResolvedValue(undefined)
    const prepareCustomerMessageGroup = vi.fn()
    const preparedProcess = vi.fn()
    const processor = createProcessor({
      enableTestFailureInjection: true,
      enqueueOutcomes,
      logger,
      preparedProcess,
      prepareCustomerMessageGroup,
    })

    const result = await processor.processCustomerGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [message],
    })

    expect(result).toEqual([
      {
        message,
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
          message,
          outcome: {
            state: "failed",
            failureStage: "rating_fact",
            failureReason: "raw_ingestion_queue_processing_failed",
            replayable: true,
          },
        },
      ],
    })
    expect(logger.error).toHaveBeenCalledWith(
      "raw ingestion queue processing failed",
      expect.objectContaining({
        customerId: "cus_123",
        projectId: "proj_123",
      })
    )
  })

  it("retries raw messages when failed status reporting cannot be enqueued", async () => {
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
    const enqueueOutcomes = vi.fn().mockRejectedValue(new Error("reporting down"))
    const processor = createProcessor({
      enqueueOutcomes,
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
      "raw ingestion failure reporting enqueue failed",
      expect.objectContaining({
        customerId: "cus_123",
        projectId: "proj_123",
      })
    )
  })

  it("keeps already reported stale messages rejected when later fresh processing fails", async () => {
    const logger = createLogger()
    const staleMessage = createMessage({
      id: "evt_stale",
      idempotencyKey: "idem_stale",
      timestamp: TEST_NOW - INGESTION_MAX_EVENT_AGE_MS - 1,
    })
    const freshMessage = createMessage({
      id: "evt_fresh",
      idempotencyKey: "idem_fresh",
      timestamp: TEST_NOW,
    })
    const enqueueOutcomes = vi.fn().mockResolvedValue(undefined)
    const processor = createProcessor({
      enqueueOutcomes,
      logger,
      preparedProcess: vi.fn().mockRejectedValue(new Error("apply failed")),
      preparedGroup: {
        candidateEntitlements: [],
        messages: [freshMessage],
      },
    })

    const result = await processor.processCustomerGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [freshMessage, staleMessage],
    })

    expect(result).toEqual([
      {
        message: freshMessage,
        disposition: {
          action: "ack",
        },
      },
      {
        message: staleMessage,
        disposition: {
          action: "ack",
        },
      },
    ])
    expect(enqueueOutcomes).toHaveBeenNthCalledWith(1, {
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
    expect(enqueueOutcomes).toHaveBeenNthCalledWith(2, {
      customerId: "cus_123",
      projectId: "proj_123",
      outcomes: [
        {
          message: freshMessage,
          outcome: {
            state: "failed",
            failureStage: "rating_fact",
            failureReason: "raw_ingestion_queue_processing_failed",
            replayable: true,
          },
        },
      ],
    })
  })
})

function createProcessor(
  overrides: {
    enableTestFailureInjection?: boolean
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
    enableTestFailureInjection: overrides.enableTestFailureInjection,
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
