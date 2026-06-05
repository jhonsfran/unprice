import { describe, expect, it, vi } from "vitest"
import type { IngestionMessageProcessingResult } from "./interface"
import type { IngestionQueueConsumerMessage, IngestionQueueMessage } from "./message"
import {
  ackDuplicateQueuedMessages,
  applyIngestionGroupResults,
  groupQueuedMessagesByCustomer,
  parseIngestionQueueBatchMessages,
  retryQueuedMessages,
} from "./queue-consumer-helpers"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("queue consumer helpers", () => {
  it("parses valid queue messages and acks malformed messages", () => {
    const logger = createLogger()
    const validMessage = createQueueMessage()
    const malformedMessage = {
      ack: vi.fn(),
      retry: vi.fn(),
      body: {
        version: 2,
      },
    }

    const parsed = parseIngestionQueueBatchMessages(
      {
        messages: [validMessage, malformedMessage as never],
      },
      logger
    )

    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.body).toEqual(validMessage.body)
    expect(validMessage.ack).not.toHaveBeenCalled()
    expect(malformedMessage.ack).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      "dropping malformed ingestion queue message",
      expect.objectContaining({
        errors: expect.any(Array),
      })
    )
  })

  it("acks duplicate queued messages and logs their identity", () => {
    const logger = createLogger()
    const duplicate = createConsumerMessage()

    ackDuplicateQueuedMessages([duplicate], logger)

    expect(duplicate.ack).toHaveBeenCalledTimes(1)
    expect(logger.debug).toHaveBeenCalledWith(
      "dropping duplicate ingestion queue message from same batch",
      {
        projectId: "proj_123",
        customerId: "cus_123",
        eventId: "evt_123",
        idempotencyKey: "idem_123",
      }
    )
  })

  it("groups queued messages by project/customer and sorts each group", () => {
    const later = createConsumerMessage({
      id: "evt_later",
      idempotencyKey: "idem_later",
      timestamp: TEST_NOW,
    })
    const earlier = createConsumerMessage({
      id: "evt_earlier",
      idempotencyKey: "idem_earlier",
      timestamp: TEST_NOW - 10,
    })
    const otherCustomer = createConsumerMessage({
      customerId: "cus_other",
      id: "evt_other",
      idempotencyKey: "idem_other",
    })

    const groups = groupQueuedMessagesByCustomer([later, otherCustomer, earlier])

    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({
      projectId: "proj_123",
      customerId: "cus_123",
    })
    expect(groups[0]?.messages.map((message) => message.body.id)).toEqual([
      "evt_earlier",
      "evt_later",
    ])
    expect(groups[1]?.customerId).toBe("cus_other")
  })

  it("applies ack, retry, and missing-result dispositions", () => {
    const logger = createLogger()
    const acked = createConsumerMessage({ idempotencyKey: "idem_ack" })
    const retried = createConsumerMessage({ idempotencyKey: "idem_retry" })
    const missing = createConsumerMessage({ idempotencyKey: "idem_missing" })
    const results: IngestionMessageProcessingResult[] = [
      {
        message: acked.body,
        disposition: { action: "ack" },
      },
      {
        message: retried.body,
        disposition: { action: "retry", retryAfterSeconds: 30 },
      },
    ]

    applyIngestionGroupResults({
      logger,
      queueMessages: [acked, retried, missing],
      results,
    })

    expect(acked.ack).toHaveBeenCalledTimes(1)
    expect(retried.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(missing.retry).toHaveBeenCalledWith()
    expect(logger.error).toHaveBeenCalledWith(
      "missing ingestion processing result for queued message",
      expect.objectContaining({
        idempotencyKey: "idem_missing",
      })
    )
  })

  it("retries every queued message in a group", () => {
    const first = createConsumerMessage({ id: "evt_1" })
    const second = createConsumerMessage({ id: "evt_2" })

    retryQueuedMessages([first, second])

    expect(first.retry).toHaveBeenCalledTimes(1)
    expect(second.retry).toHaveBeenCalledTimes(1)
  })
})

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
  }
}

function createQueueMessage(overrides: Partial<IngestionQueueMessage> = {}) {
  return {
    ack: vi.fn(),
    retry: vi.fn(),
    body: createMessage(overrides),
  }
}

function createConsumerMessage(
  overrides: Partial<IngestionQueueMessage> = {}
): IngestionQueueConsumerMessage {
  return {
    ack: vi.fn(),
    retry: vi.fn(),
    body: createMessage(overrides),
  }
}

function createMessage(overrides: Partial<IngestionQueueMessage> = {}): IngestionQueueMessage {
  return {
    version: 1,
    projectId: "proj_123",
    customerId: "cus_123",
    requestId: "req_123",
    receivedAt: TEST_NOW,
    idempotencyKey: "idem_123",
    id: "evt_123",
    slug: "usage.recorded",
    timestamp: TEST_NOW,
    properties: { amount: 1 },
    ...overrides,
  }
}
