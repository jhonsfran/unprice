import { describe, expect, it, vi } from "vitest"
import { classifyIngestionQueue, dispatchIngestionQueueBatch } from "./queue-routing"

describe("classifyIngestionQueue", () => {
  it("classifies every configured queue name across envs", () => {
    for (const env of ["prod", "preview", "dev"]) {
      expect(classifyIngestionQueue(`unprice-api-ingestion-shard-0-${env}`)).toBe("raw")
      expect(classifyIngestionQueue(`unprice-api-ingestion-reporting-${env}`)).toBe("reporting")
      expect(classifyIngestionQueue(`unprice-api-ingestion-dlq-${env}`)).toBe("raw_dlq")
      expect(classifyIngestionQueue(`unprice-api-ingestion-reporting-dlq-${env}`)).toBe(
        "reporting_dlq"
      )
    }
  })

  it("does not classify queues without a known positive prefix", () => {
    expect(classifyIngestionQueue("unprice-api-ingestion-shards-0-prod")).toBeUndefined()
    expect(classifyIngestionQueue("unprice-api-ingestion-reports-prod")).toBeUndefined()
  })

  it("does not classify prefixed lookalikes as special queues", () => {
    expect(classifyIngestionQueue("not-unprice-api-ingestion-reporting-prod")).toBeUndefined()
    expect(classifyIngestionQueue("foo-unprice-api-ingestion-dlq-prod")).toBeUndefined()
  })

  it("accepts legitimate environment suffixes", () => {
    expect(classifyIngestionQueue("unprice-api-ingestion-reporting-staging-eu")).toBe("reporting")
    expect(classifyIngestionQueue("unprice-api-ingestion-dlq-local-test")).toBe("raw_dlq")
    expect(classifyIngestionQueue("unprice-api-ingestion-reporting-dlq-local-test")).toBe(
      "reporting_dlq"
    )
  })
})

describe("dispatchIngestionQueueBatch unknown queues", () => {
  it("logs a renamed reporting queue and retries every message without acknowledging", async () => {
    const first = createMessage()
    const second = createMessage()
    const onUnknownQueue = vi.fn()
    const consumers = {
      raw: vi.fn(),
      raw_dlq: vi.fn(),
      reporting: vi.fn(),
      reporting_dlq: vi.fn(),
    }
    const batch = {
      ackAll: vi.fn(),
      messages: [first.message, second.message],
      queue: "unprice-api-ingestion-reports-prod",
      retryAll: vi.fn(),
    } as unknown as MessageBatch<unknown>

    await dispatchIngestionQueueBatch(batch, { consumers, onUnknownQueue })

    expect(onUnknownQueue).toHaveBeenCalledWith({ queue: batch.queue })
    expect(first.retry).toHaveBeenCalledOnce()
    expect(second.retry).toHaveBeenCalledOnce()
    expect(second.retry.mock.invocationCallOrder[0]).toBeLessThan(
      onUnknownQueue.mock.invocationCallOrder[0] ?? 0
    )
    expect(first.ack).not.toHaveBeenCalled()
    expect(second.ack).not.toHaveBeenCalled()
    for (const consume of Object.values(consumers)) {
      expect(consume).not.toHaveBeenCalled()
    }
  })
})

function createMessage() {
  const ack = vi.fn()
  const retry = vi.fn()

  return {
    ack,
    message: { ack, body: {}, retry } as unknown as Message<unknown>,
    retry,
  }
}
