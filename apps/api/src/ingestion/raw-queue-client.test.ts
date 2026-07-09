import type { Logger } from "@unprice/logs"
import type { IngestionQueueMessage } from "@unprice/services/ingestion"
import { describe, expect, it, vi } from "vitest"
import { CloudflareRawIngestionQueueClient, selectQueueShardIndex } from "./raw-queue-client"

const message: IngestionQueueMessage = {
  version: 1,
  workspaceId: "ws_123",
  projectId: "proj_123",
  customerId: "cus_123",
  requestId: "req_123",
  receivedAt: Date.UTC(2026, 2, 18, 10, 0, 0),
  idempotencyKey: "idem_123",
  id: "evt_123",
  slug: "tokens_used",
  timestamp: Date.UTC(2026, 2, 18, 10, 0, 0),
  properties: { amount: 42 },
  source: {
    environment: "development",
    apiKeyId: "key_123",
    sourceType: "api_key",
    sourceId: "key_123",
    sourceName: null,
  },
  ingestionMode: "async",
}

describe("CloudflareRawIngestionQueueClient", () => {
  it("sends a message once when the queue accepts it", async () => {
    const queue = createQueue()
    const logger = createLogger()
    const client = new CloudflareRawIngestionQueueClient({ logger, queues: [queue] })

    await client.send(message)

    expect(queue.send).toHaveBeenCalledOnce()
    expect(queue.send).toHaveBeenCalledWith(message)
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("retries a rejected send and succeeds", async () => {
    const queue = createQueue()
    queue.send.mockRejectedValueOnce(new Error("queue unavailable"))
    const logger = createLogger()
    const client = new CloudflareRawIngestionQueueClient({
      logger,
      queues: [queue],
      baseDelayMs: 0,
    })

    await client.send(message)

    expect(queue.send).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.warn).toHaveBeenCalledWith(
      "raw ingestion queue send failed",
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 3,
        error_message: "queue unavailable",
        error_type: "Error",
      })
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("rejects after the final send attempt", async () => {
    const queue = createQueue()
    queue.send.mockRejectedValue(new Error("queue unavailable"))
    const logger = createLogger()
    const client = new CloudflareRawIngestionQueueClient({
      logger,
      queues: [queue],
      baseDelayMs: 0,
    })

    await expect(client.send(message)).rejects.toThrow("Failed to enqueue ingestion event")

    expect(queue.send).toHaveBeenCalledTimes(3)
    expect(logger.warn).toHaveBeenCalledTimes(3)
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "queue unavailable" }),
      {
        operation: "raw_ingestion_queue_send_permanent",
        projectId: message.projectId,
        customerId: message.customerId,
        eventId: message.id,
        idempotencyKey: message.idempotencyKey,
      }
    )
  })

  it("selects shards deterministically by customer id", () => {
    const customerIds = ["cus_123", "cus_124", "cus_125"]
    const shardIndexes = customerIds.map((customerId) => selectQueueShardIndex(customerId, 3))

    expect(shardIndexes).toEqual([0, 1, 2])
    for (const [index, customerId] of customerIds.entries()) {
      expect(selectQueueShardIndex(customerId, 3)).toBe(shardIndexes[index])
    }
  })

  it("sends only to the shard selected for the customer", async () => {
    const firstQueue = createQueue()
    const selectedQueue = createQueue()
    const customerId = "cus_124"
    const client = new CloudflareRawIngestionQueueClient({
      logger: createLogger(),
      queues: [firstQueue, selectedQueue],
    })

    expect(selectQueueShardIndex(customerId, 2)).toBe(1)

    await client.send({ ...message, customerId })

    expect(firstQueue.send).not.toHaveBeenCalled()
    expect(selectedQueue.send).toHaveBeenCalledOnce()
    expect(selectedQueue.send).toHaveBeenCalledWith({ ...message, customerId })
  })

  it("rejects construction without a queue shard", () => {
    expect(
      () => new CloudflareRawIngestionQueueClient({ logger: createLogger(), queues: [] })
    ).toThrow("CloudflareRawIngestionQueueClient requires at least one queue shard")
  })
})

function createQueue(): Queue<IngestionQueueMessage> {
  return {
    send: vi.fn<Queue<IngestionQueueMessage>["send"]>().mockResolvedValue(undefined),
  } as Queue<IngestionQueueMessage>
}

function createLogger(): Pick<Logger, "error" | "warn"> {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  }
}
