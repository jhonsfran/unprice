import { describe, expect, it, vi } from "vitest"
import { INGESTION_MAX_EVENT_AGE_MS } from "../entitlements"
import type { FanoutMessageOutcome } from "./fanout-outcomes"
import type { IngestionOutcome } from "./interface"
import type { IngestionQueueMessage } from "./message"
import {
  IngestionMessageOutcomes,
  ackMessage,
  mapOutcomesToAckResults,
  retryMessage,
  toSyncResult,
} from "./message-outcomes"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("IngestionMessageOutcomes", () => {
  it("returns no outcome for fresh messages", () => {
    const logger = createLogger()
    const outcomes = new IngestionMessageOutcomes({ logger, now: () => TEST_NOW })

    const result = outcomes.resolveTooOldOutcome({
      customerId: "cus_123",
      projectId: "proj_123",
      message: createMessage({ timestamp: TEST_NOW - INGESTION_MAX_EVENT_AGE_MS }),
    })

    expect(result).toBeNull()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("logs and returns EVENT_TOO_OLD for stale messages", () => {
    const logger = createLogger()
    const outcomes = new IngestionMessageOutcomes({ logger, now: () => TEST_NOW })
    const message = createMessage({ timestamp: TEST_NOW - INGESTION_MAX_EVENT_AGE_MS - 1 })

    const result = outcomes.resolveTooOldOutcome({
      customerId: "cus_123",
      projectId: "proj_123",
      message,
    })

    expect(result).toEqual({ state: "rejected", rejectionReason: "EVENT_TOO_OLD" })
    expect(logger.warn).toHaveBeenCalledWith(
      "raw ingestion event rejected as too old",
      expect.objectContaining({
        eventId: message.id,
        eventAgeMs: INGESTION_MAX_EVENT_AGE_MS + 1,
        rejectionReason: "EVENT_TOO_OLD",
      })
    )
  })

  it("partitions stale messages into rejected outcomes and leaves fresh messages", () => {
    const logger = createLogger()
    const outcomes = new IngestionMessageOutcomes({ logger, now: () => TEST_NOW })
    const staleMessage = createMessage({
      id: "evt_stale",
      timestamp: TEST_NOW - INGESTION_MAX_EVENT_AGE_MS - 1,
    })
    const freshMessage = createMessage({
      id: "evt_fresh",
      timestamp: TEST_NOW - INGESTION_MAX_EVENT_AGE_MS,
    })

    const result = outcomes.partitionTooOldMessages({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [staleMessage, freshMessage],
    })

    expect(result.freshMessages).toEqual([freshMessage])
    expect(result.tooOldOutcomes).toEqual([
      {
        message: staleMessage,
        outcome: { state: "rejected", rejectionReason: "EVENT_TOO_OLD" },
      },
    ])
    expect(logger.warn).toHaveBeenCalledWith(
      "raw ingestion message rejected",
      expect.objectContaining({
        eventId: staleMessage.id,
        rejectionReason: "EVENT_TOO_OLD",
      })
    )
  })

  it("builds customer-not-found outcomes and logs each rejection", () => {
    const logger = createLogger()
    const outcomes = new IngestionMessageOutcomes({ logger, now: () => TEST_NOW })
    const firstMessage = createMessage({ id: "evt_1" })
    const secondMessage = createMessage({ id: "evt_2" })

    const result = outcomes.buildCustomerNotFoundOutcomes([firstMessage, secondMessage], {
      customerId: "cus_123",
      projectId: "proj_123",
      rejectionReason: "CUSTOMER_NOT_FOUND",
    })

    expect(result).toEqual([
      {
        message: firstMessage,
        outcome: { state: "rejected", rejectionReason: "CUSTOMER_NOT_FOUND" },
      },
      {
        message: secondMessage,
        outcome: { state: "rejected", rejectionReason: "CUSTOMER_NOT_FOUND" },
      },
    ])
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})

describe("message disposition helpers", () => {
  it("maps outcomes to ack results", () => {
    const message = createMessage()
    const outcome: FanoutMessageOutcome = {
      message,
      outcome: { state: "processed" },
    }

    expect(mapOutcomesToAckResults([outcome])).toEqual([ackMessage(message)])
  })

  it("builds retry results with optional delay", () => {
    const message = createMessage()

    expect(retryMessage(message, 30)).toEqual({
      message,
      disposition: {
        action: "retry",
        retryAfterSeconds: 30,
      },
    })
  })

  it("builds sync results from ingestion outcomes", () => {
    const outcome: IngestionOutcome = {
      state: "rejected",
      rejectionReason: "LIMIT_EXCEEDED",
    }

    expect(toSyncResult({ allowed: false, message: "limit reached", outcome })).toEqual({
      allowed: false,
      message: "limit reached",
      rejectionReason: "LIMIT_EXCEEDED",
      state: "rejected",
    })
  })
})

function createLogger() {
  return {
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
