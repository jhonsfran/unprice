import { describe, expect, it, vi } from "vitest"
import { dispatchIngestionQueueBatch } from "./queue-routing"

type RawBody = { kind: "raw"; value: string }
type ReportingBody = { kind: "reporting"; value: string }

describe("dispatchIngestionQueueBatch", () => {
  it("uses only the raw schema and consumer for a raw queue", async () => {
    const options = createOptions()
    const batch = createBatch("unprice-api-ingestion-shard-0-prod", [
      createMessage({ kind: "raw", value: "raw-1" }).message,
    ])

    await dispatchIngestionQueueBatch(batch, options)

    expect(options.rawSchema.safeParse).toHaveBeenCalledOnce()
    expect(options.reportingSchema.safeParse).not.toHaveBeenCalled()
    expect(options.consumeRaw).toHaveBeenCalledOnce()
    expect(options.consumeRawDlq).not.toHaveBeenCalled()
    expect(options.consumeReporting).not.toHaveBeenCalled()
    expect(options.consumeReportingDlq).not.toHaveBeenCalled()
  })

  it("uses only the reporting schema and consumer for a reporting queue", async () => {
    const options = createOptions()
    const batch = createBatch("unprice-api-ingestion-reporting-preview", [
      createMessage({ kind: "reporting", value: "report-1" }).message,
    ])

    await dispatchIngestionQueueBatch(batch, options)

    expect(options.rawSchema.safeParse).not.toHaveBeenCalled()
    expect(options.reportingSchema.safeParse).toHaveBeenCalledOnce()
    expect(options.consumeRaw).not.toHaveBeenCalled()
    expect(options.consumeRawDlq).not.toHaveBeenCalled()
    expect(options.consumeReporting).toHaveBeenCalledOnce()
    expect(options.consumeReportingDlq).not.toHaveBeenCalled()
  })

  it("uses the raw schema and DLQ consumer for a raw DLQ", async () => {
    const options = createOptions()
    const batch = createBatch("unprice-api-ingestion-dlq-prod", [
      createMessage({ kind: "raw", value: "raw-1" }).message,
    ])

    await dispatchIngestionQueueBatch(batch, options)

    expect(options.rawSchema.safeParse).toHaveBeenCalledOnce()
    expect(options.reportingSchema.safeParse).not.toHaveBeenCalled()
    expect(options.consumeRaw).not.toHaveBeenCalled()
    expect(options.consumeRawDlq).toHaveBeenCalledOnce()
    expect(options.consumeReporting).not.toHaveBeenCalled()
    expect(options.consumeReportingDlq).not.toHaveBeenCalled()
  })

  it("acks each malformed message once and delivers valid messages", async () => {
    const options = createOptions()
    const valid = createMessage({ kind: "raw", value: "raw-1" }, "valid")
    const malformed = createMessage({ kind: "invalid" }, "malformed")
    const batch = createBatch("unprice-api-ingestion-shard-1-dev", [
      valid.message,
      malformed.message,
    ])

    await dispatchIngestionQueueBatch(batch, options)

    expect(malformed.ack).toHaveBeenCalledOnce()
    expect(valid.ack).not.toHaveBeenCalled()
    expect(options.onMalformed).toHaveBeenCalledWith({
      queue: batch.queue,
      errors: ["invalid raw message"],
    })
    const routedBatch = options.consumeRaw.mock.calls[0]?.[0]
    expect(routedBatch?.messages).toHaveLength(1)
    expect(routedBatch?.messages[0]?.body).toEqual({ kind: "raw", value: "raw-1" })
  })

  it("does not call a consumer when every message is malformed", async () => {
    const options = createOptions()
    const first = createMessage({ kind: "invalid" }, "first")
    const second = createMessage(null, "second")

    await dispatchIngestionQueueBatch(
      createBatch("unprice-api-ingestion-shard-0-prod", [first.message, second.message]),
      options
    )

    expect(first.ack).toHaveBeenCalledOnce()
    expect(second.ack).toHaveBeenCalledOnce()
    expect(options.consumeRaw).not.toHaveBeenCalled()
    expect(options.consumeRawDlq).not.toHaveBeenCalled()
    expect(options.consumeReporting).not.toHaveBeenCalled()
    expect(options.consumeReportingDlq).not.toHaveBeenCalled()
  })

  it("preserves queue and message metadata with bound ack and retry methods", async () => {
    const options = createOptions()
    const original = createMessage({ kind: "raw", value: "raw-1" }, "message-123")
    const batch = createBatch("unprice-api-ingestion-shard-0-prod", [original.message])

    await dispatchIngestionQueueBatch(batch, options)

    const routedBatch = options.consumeRaw.mock.calls[0]?.[0]
    const routedMessage = routedBatch?.messages[0]
    expect(routedBatch?.queue).toBe(batch.queue)
    expect(routedMessage).toMatchObject({
      attempts: 3,
      id: "message-123",
      timestamp: original.message.timestamp,
    })

    routedMessage?.ack()
    routedMessage?.retry()

    expect(original.ack).toHaveBeenCalledOnce()
    expect(original.retry).toHaveBeenCalledOnce()
    expect(original.getAckReceiver()).toBe(original.message)
    expect(original.getRetryReceiver()).toBe(original.message)
  })

  it("uses the reporting schema and DLQ consumer for a reporting DLQ", async () => {
    const options = createOptions()
    const queue = "unprice-api-ingestion-reporting-dlq-prod"
    const message = createMessage({ kind: "reporting", value: "report-1" })

    await dispatchIngestionQueueBatch(createBatch(queue, [message.message]), options)

    expect(options.rawSchema.safeParse).not.toHaveBeenCalled()
    expect(options.reportingSchema.safeParse).toHaveBeenCalledOnce()
    expect(options.consumeRaw).not.toHaveBeenCalled()
    expect(options.consumeRawDlq).not.toHaveBeenCalled()
    expect(options.consumeReporting).not.toHaveBeenCalled()
    expect(options.consumeReportingDlq).toHaveBeenCalledOnce()
    expect(options.consumeReportingDlq.mock.calls[0]?.[0].messages[0]?.body).toEqual({
      kind: "reporting",
      value: "report-1",
    })
  })

  it("acks malformed reporting DLQ messages without calling its consumer", async () => {
    const options = createOptions()
    const malformed = createMessage({ kind: "invalid" })
    const queue = "unprice-api-ingestion-reporting-dlq-preview"

    await dispatchIngestionQueueBatch(createBatch(queue, [malformed.message]), options)

    expect(malformed.ack).toHaveBeenCalledOnce()
    expect(options.onMalformed).toHaveBeenCalledWith({
      queue,
      errors: ["invalid reporting message"],
    })
    expect(options.consumeReportingDlq).not.toHaveBeenCalled()
  })
})

function createOptions() {
  const rawSchema = {
    safeParse: vi.fn((value: unknown) => {
      if (hasKind(value, "raw")) {
        return { success: true as const, data: value as RawBody }
      }
      return { success: false as const, error: { issues: ["invalid raw message"] } }
    }),
  }
  const reportingSchema = {
    safeParse: vi.fn((value: unknown) => {
      if (hasKind(value, "reporting")) {
        return { success: true as const, data: value as ReportingBody }
      }
      return { success: false as const, error: { issues: ["invalid reporting message"] } }
    }),
  }

  return {
    consumeRaw: vi.fn(async (_batch: MessageBatch<RawBody>) => {}),
    consumeRawDlq: vi.fn(async (_batch: MessageBatch<RawBody>) => {}),
    consumeReporting: vi.fn(async (_batch: MessageBatch<ReportingBody>) => {}),
    consumeReportingDlq: vi.fn(async (_batch: MessageBatch<ReportingBody>) => {}),
    onMalformed: vi.fn(),
    rawSchema,
    reportingSchema,
  }
}

function hasKind(value: unknown, kind: string): boolean {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === kind
}

function createBatch(queue: string, messages: Message<unknown>[]): MessageBatch<unknown> {
  return {
    ackAll: vi.fn(),
    messages,
    queue,
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>
}

function createMessage(body: unknown, id = "message-1") {
  let ackReceiver: unknown
  let retryReceiver: unknown
  const ack = vi.fn(function (this: unknown) {
    ackReceiver = this
  })
  const retry = vi.fn(function (this: unknown) {
    retryReceiver = this
  })
  const message = {
    ack,
    attempts: 3,
    body,
    id,
    retry,
    timestamp: new Date("2026-07-09T12:00:00.000Z"),
  } as unknown as Message<unknown>

  return {
    ack,
    getAckReceiver: () => ackReceiver,
    getRetryReceiver: () => retryReceiver,
    message,
    retry,
  }
}
