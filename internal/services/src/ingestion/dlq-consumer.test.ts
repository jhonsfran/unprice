import { describe, expect, it, vi } from "vitest"
import { IngestionDlqConsumer } from "./dlq-consumer"
import type { IngestionQueueMessage } from "./message"

describe("IngestionDlqConsumer", () => {
  it("reports dead letters as replayable raw-ingestion failures and acknowledges them", async () => {
    const firstMessage = buildQueueMessage(buildMessage())
    const secondMessage = buildQueueMessage(
      buildMessage({
        customerId: "cus_2",
        id: "evt_2",
        idempotencyKey: "idem_2",
      })
    )
    const enqueueOutcomes = vi.fn().mockResolvedValue(undefined)
    const consumer = new IngestionDlqConsumer({
      logger: createLogger(),
      now: () => 2_000,
      reportingDispatcher: { enqueueOutcomes },
    })

    await consumer.consumeBatch({ messages: [firstMessage, secondMessage] })

    expect(enqueueOutcomes).toHaveBeenCalledTimes(2)
    expect(enqueueOutcomes.mock.calls[0]?.[0]).toEqual({
      customerId: "cus_1",
      outcomes: [
        {
          message: firstMessage.body,
          outcome: {
            state: "failed",
            failureMessage: undefined,
            failureStage: "raw_ingestion",
            failureReason: "dead_letter_exhausted_retries",
            replayable: true,
          },
        },
      ],
      projectId: "proj_1",
    })
    expect(firstMessage.ack).toHaveBeenCalledOnce()
    expect(secondMessage.ack).toHaveBeenCalledOnce()
  })

  it("retries a dead letter when reporting enqueue fails", async () => {
    const message = buildQueueMessage(buildMessage())
    const error = new Error("reporting unavailable")
    const logger = createLogger()
    const consumer = new IngestionDlqConsumer({
      logger,
      now: () => 2_000,
      reportingDispatcher: {
        enqueueOutcomes: vi.fn().mockRejectedValue(error),
      },
    })

    await consumer.consumeBatch({ messages: [message] })

    expect(message.retry).toHaveBeenCalledOnce()
    expect(message.ack).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(error, {
      operation: "ingestion_dlq_reporting_enqueue",
      projectId: "proj_1",
      customerId: "cus_1",
      dead_letter_count: 1,
    })
  })

  it("retries a failed customer group and continues reporting later groups", async () => {
    const firstMessage = buildQueueMessage(buildMessage())
    const secondMessage = buildQueueMessage(
      buildMessage({ id: "evt_2", idempotencyKey: "idem_2", timestamp: 1_001 })
    )
    const laterFirstMessage = buildQueueMessage(
      buildMessage({ customerId: "cus_2", id: "evt_3", idempotencyKey: "idem_3" })
    )
    const laterSecondMessage = buildQueueMessage(
      buildMessage({
        customerId: "cus_2",
        id: "evt_4",
        idempotencyKey: "idem_4",
        timestamp: 1_001,
      })
    )
    const enqueueOutcomes = vi.fn(async ({ customerId }: { customerId: string }): Promise<void> => {
      if (customerId === "cus_1") {
        throw new Error("first group unavailable")
      }
    })
    const consumer = new IngestionDlqConsumer({
      logger: createLogger(),
      now: () => 2_000,
      reportingDispatcher: { enqueueOutcomes },
    })

    await consumer.consumeBatch({
      messages: [firstMessage, laterFirstMessage, secondMessage, laterSecondMessage],
    })

    expect(enqueueOutcomes).toHaveBeenCalledTimes(2)
    expect(enqueueOutcomes.mock.calls.map(([call]) => call.customerId)).toEqual(["cus_1", "cus_2"])
    expect(firstMessage.retry).toHaveBeenCalledOnce()
    expect(secondMessage.retry).toHaveBeenCalledOnce()
    expect(firstMessage.ack).not.toHaveBeenCalled()
    expect(secondMessage.ack).not.toHaveBeenCalled()
    expect(laterFirstMessage.retry).not.toHaveBeenCalled()
    expect(laterSecondMessage.retry).not.toHaveBeenCalled()
    expect(laterFirstMessage.ack).toHaveBeenCalledOnce()
    expect(laterSecondMessage.ack).toHaveBeenCalledOnce()
  })

  it("acknowledges malformed dead letters without reporting them", async () => {
    const malformedMessage = buildQueueMessage({ malformed: true } as never)
    const enqueueOutcomes = vi.fn()
    const consumer = new IngestionDlqConsumer({
      logger: createLogger(),
      now: () => 2_000,
      reportingDispatcher: { enqueueOutcomes },
    })

    await consumer.consumeBatch({ messages: [malformedMessage] })

    expect(enqueueOutcomes).not.toHaveBeenCalled()
    expect(malformedMessage.ack).toHaveBeenCalledOnce()
    expect(malformedMessage.retry).not.toHaveBeenCalled()
  })
})

function buildMessage(overrides: Partial<IngestionQueueMessage> = {}): IngestionQueueMessage {
  return {
    version: 1,
    workspaceId: "ws_1",
    projectId: "proj_1",
    customerId: "cus_1",
    requestId: "req_1",
    receivedAt: 1_000,
    idempotencyKey: "idem_1",
    id: "evt_1",
    slug: "tokens_used",
    timestamp: 1_000,
    properties: { amount: 1 },
    source: {
      environment: "test",
      apiKeyId: "key_1",
      sourceType: "api_key",
      sourceId: "key_1",
      sourceName: null,
    },
    ingestionMode: "async",
    ...overrides,
  }
}

function buildQueueMessage(body: IngestionQueueMessage) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }
}
