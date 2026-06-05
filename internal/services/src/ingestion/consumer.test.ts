import { describe, expect, it, vi } from "vitest"
import { IngestionQueueConsumer } from "./consumer"
import type { IngestionQueueMessage } from "./message"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("IngestionQueueConsumer", () => {
  it("retries every message in a customer group when processing throws", async () => {
    const firstMessage = createQueueMessage({
      id: "evt_1",
      idempotencyKey: "idem_1",
      timestamp: TEST_NOW - 10,
    })
    const secondMessage = createQueueMessage({
      id: "evt_2",
      idempotencyKey: "idem_2",
      timestamp: TEST_NOW,
    })
    const logger = createLogger()
    const processCustomerGroup = vi.fn().mockRejectedValue(new Error("processor failed"))
    const consumer = new IngestionQueueConsumer({
      logger: logger as never,
      processor: {
        processCustomerGroup,
      },
    })

    await consumer.consumeBatch({
      messages: [secondMessage, firstMessage],
    })

    expect(processCustomerGroup).toHaveBeenCalledWith({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [firstMessage.body, secondMessage.body],
    })
    expect(firstMessage.retry).toHaveBeenCalledTimes(1)
    expect(secondMessage.retry).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      "ingestion queue group processing failed",
      expect.objectContaining({
        customerId: "cus_123",
        projectId: "proj_123",
      })
    )
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
