import { describe, expect, it, vi } from "vitest"
import { dispatchIngestionQueueBatch } from "./queue-routing"

describe("dispatchIngestionQueueBatch", () => {
  it.each([
    ["raw", "unprice-api-ingestion-shard-0-prod"],
    ["raw_dlq", "unprice-api-ingestion-dlq-preview"],
    ["reporting", "unprice-api-ingestion-reporting-dev"],
    ["reporting_dlq", "unprice-api-ingestion-reporting-dlq-prod"],
  ] as const)("routes %s batches without parsing or cloning them", async (kind, queue) => {
    const options = createOptions()
    const batch = createBatch(queue, [createMessage({ malformed: true })])

    await dispatchIngestionQueueBatch(batch, options)

    expect(options.consumers[kind]).toHaveBeenCalledWith(batch)
    for (const [otherKind, consume] of Object.entries(options.consumers)) {
      if (otherKind !== kind) {
        expect(consume).not.toHaveBeenCalled()
      }
    }
  })
})

function createOptions() {
  return {
    consumers: {
      raw: vi.fn(),
      raw_dlq: vi.fn(),
      reporting: vi.fn(),
      reporting_dlq: vi.fn(),
    },
    onUnknownQueue: vi.fn(),
  }
}

function createBatch(queue: string, messages: Message<unknown>[]): MessageBatch<unknown> {
  return {
    ackAll: vi.fn(),
    messages,
    queue,
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>
}

function createMessage(body: unknown) {
  return {
    ack: vi.fn(),
    body,
  } as unknown as Message<unknown>
}
