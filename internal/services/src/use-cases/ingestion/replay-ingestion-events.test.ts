import { FetchError } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import type { IngestionQueueMessage, RawIngestionQueueClient } from "../../ingestion"
import {
  type ReplayIngestionEventsAnalytics,
  type ReplayIngestionEventsDeps,
  replayIngestionEvents,
} from "./replay-ingestion-events"

describe("replayIngestionEvents", () => {
  it("dedupes audit ids, replaces the request id, and preserves replay identity", async () => {
    const originalMessage = createMessage()
    const { analytics, deps, sentMessages } = makeDeps([
      { payload_json: JSON.stringify(originalMessage) },
    ])

    const result = await replayIngestionEvents(deps, {
      canonicalAuditIds: ["audit_1", "audit_1", "audit_2"],
      projectId: "proj_123",
      requestId: "req_replay",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({ replayed: 1, skipped: 1 })
    expect(analytics.getIngestionReplayPayloads).toHaveBeenCalledWith({
      project_id: "proj_123",
      canonical_audit_ids: "audit_1,audit_2",
    })
    expect(sentMessages).toEqual([
      {
        ...originalMessage,
        requestId: "req_replay",
      },
    ])
    expect(sentMessages[0]).toMatchObject({
      id: "evt_123",
      idempotencyKey: "idem_123",
    })
  })

  it("rejects a payload from a different project without sending any messages", async () => {
    const { deps, sentMessages } = makeDeps([
      { payload_json: JSON.stringify(createMessage()) },
      {
        payload_json: JSON.stringify(createMessage({ projectId: "proj_other" })),
      },
    ])

    const result = await replayIngestionEvents(deps, {
      canonicalAuditIds: ["audit_1", "audit_2"],
      projectId: "proj_123",
      requestId: "req_replay",
    })

    expect(result.val).toBeUndefined()
    expect(result.err).toMatchObject({ reason: "project_mismatch" })
    expect(result.err?.message).toBe("Replay payload project does not match request project")
    expect(sentMessages).toHaveLength(0)
  })

  it("rejects invalid JSON without sending any messages", async () => {
    const { deps, sentMessages } = makeDeps([
      { payload_json: JSON.stringify(createMessage()) },
      { payload_json: "{not-json" },
    ])

    const result = await replayIngestionEvents(deps, {
      canonicalAuditIds: ["audit_1", "audit_2"],
      projectId: "proj_123",
      requestId: "req_replay",
    })

    expect(result.val).toBeUndefined()
    expect(result.err).toMatchObject({ reason: "invalid_payload" })
    expect(result.err?.message).toBe("Replay payload is not valid JSON")
    expect(sentMessages).toHaveLength(0)
  })

  it("rejects an invalid queue message without sending any messages", async () => {
    const { deps, sentMessages } = makeDeps([{ payload_json: JSON.stringify({ version: 1 }) }])

    const result = await replayIngestionEvents(deps, {
      canonicalAuditIds: ["audit_1"],
      projectId: "proj_123",
      requestId: "req_replay",
    })

    expect(result.val).toBeUndefined()
    expect(result.err).toMatchObject({ reason: "invalid_payload" })
    expect(result.err?.message).toBe("Replay payload is not a valid ingestion queue message")
    expect(sentMessages).toHaveLength(0)
  })

  it("returns a retryable fetch error when analytics rejects", async () => {
    const { deps, sentMessages } = makeDeps([], {
      analyticsError: new Error("tinybird unavailable"),
    })

    const result = await replayIngestionEvents(deps, {
      canonicalAuditIds: ["audit_1", "audit_2"],
      projectId: "proj_123",
      requestId: "req_replay",
    })

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err).toMatchObject({ retry: true })
    expect(result.err?.message).toContain("tinybird unavailable")
    expect(result.err?.context).toMatchObject({
      url: "tinybird:v1_get_ingestion_replay_payloads",
      method: "GET",
      projectId: "proj_123",
      canonicalAuditIds: ["audit_1", "audit_2"],
      errorMessage: "tinybird unavailable",
    })
    expect(sentMessages).toHaveLength(0)
  })

  it("returns a non-retryable fetch error for an invalid analytics row", async () => {
    const { deps, sentMessages } = makeDeps([{ payload_json: 42 }])

    const result = await replayIngestionEvents(deps, {
      canonicalAuditIds: ["audit_1"],
      projectId: "proj_123",
      requestId: "req_replay",
    })

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err).toMatchObject({ retry: false })
    expect(result.err?.context).toMatchObject({
      url: "tinybird:v1_get_ingestion_replay_payloads",
      method: "GET",
      projectId: "proj_123",
      canonicalAuditIds: ["audit_1"],
      rowIndex: 0,
      issues: expect.any(Array),
    })
    expect(sentMessages).toHaveLength(0)
  })

  it("returns a retryable fetch error when a later queue send fails", async () => {
    const messages = [
      createMessage(),
      createMessage({ id: "evt_456", idempotencyKey: "idem_456" }),
      createMessage({ id: "evt_789", idempotencyKey: "idem_789" }),
    ]
    const { attemptedMessages, deps, sentMessages } = makeDeps(
      messages.map((message) => ({ payload_json: JSON.stringify(message) })),
      { failOnSend: 2 }
    )

    const result = await replayIngestionEvents(deps, {
      canonicalAuditIds: ["audit_1", "audit_2", "audit_3"],
      projectId: "proj_123",
      requestId: "req_replay",
    })

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err).toMatchObject({
      message: "Failed to enqueue ingestion event",
      retry: true,
    })
    expect(result.err?.context).toMatchObject({
      projectId: "proj_123",
      eventId: "evt_456",
      idempotencyKey: "idem_456",
      alreadySent: 1,
      errorMessage: "queue unavailable",
    })
    expect(sentMessages).toEqual([
      expect.objectContaining({
        id: "evt_123",
        idempotencyKey: "idem_123",
        requestId: "req_replay",
      }),
    ])
    expect(attemptedMessages).toEqual([
      expect.objectContaining({ id: "evt_123", idempotencyKey: "idem_123" }),
      expect.objectContaining({ id: "evt_456", idempotencyKey: "idem_456" }),
    ])
    expect(attemptedMessages).not.toContainEqual(expect.objectContaining({ id: "evt_789" }))
  })

  it("returns a non-retryable fetch error when analytics exceeds requested cardinality", async () => {
    const { deps, sentMessages } = makeDeps([
      { payload_json: JSON.stringify(createMessage()) },
      {
        payload_json: JSON.stringify(createMessage({ id: "evt_456", idempotencyKey: "idem_456" })),
      },
    ])

    const result = await replayIngestionEvents(deps, {
      canonicalAuditIds: ["audit_1"],
      projectId: "proj_123",
      requestId: "req_replay",
    })

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err).toMatchObject({ retry: false })
    expect(result.err?.context).toMatchObject({
      projectId: "proj_123",
      requestedCount: 1,
      receivedCount: 2,
    })
    expect(sentMessages).toHaveLength(0)
  })
})

function makeDeps(
  rows: unknown[],
  options: {
    analyticsError?: Error
    failOnSend?: number
  } = {}
): {
  analytics: ReplayIngestionEventsAnalytics
  attemptedMessages: IngestionQueueMessage[]
  deps: ReplayIngestionEventsDeps
  sentMessages: IngestionQueueMessage[]
} {
  const attemptedMessages: IngestionQueueMessage[] = []
  const sentMessages: IngestionQueueMessage[] = []
  const analytics: ReplayIngestionEventsAnalytics = {
    getIngestionReplayPayloads: vi.fn(async () => {
      if (options.analyticsError) {
        throw options.analyticsError
      }

      return { data: rows }
    }),
  }
  const rawIngestionQueue: RawIngestionQueueClient = {
    send: vi.fn(async (message) => {
      attemptedMessages.push(message)
      if (attemptedMessages.length === options.failOnSend) {
        throw new Error("queue unavailable")
      }

      sentMessages.push(message)
    }),
  }

  return {
    analytics,
    attemptedMessages,
    deps: { analytics, rawIngestionQueue },
    sentMessages,
  }
}

function createMessage(overrides: Partial<IngestionQueueMessage> = {}): IngestionQueueMessage {
  return {
    version: 1,
    workspaceId: "ws_123",
    projectId: "proj_123",
    customerId: "cus_123",
    requestId: "req_original",
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
    ...overrides,
  }
}
