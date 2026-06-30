import { OpenAPIHono } from "@hono/zod-openapi"
import type { Analytics } from "@unprice/analytics"
import type { Logger } from "@unprice/logs"
import type { IngestionQueueMessage } from "@unprice/services/ingestion"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { registerReplayIngestionEventsV1 } from "./replayIngestionEventsV1"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
}))

vi.mock("~/auth/key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/auth/key")>()
  return {
    ...actual,
    keyAuth: authMocks.keyAuth,
  }
})

const verifiedKey = {
  id: "key_123",
  projectId: "proj_123",
  defaultCustomerId: "cus_default_123",
  project: {
    id: "proj_123",
    workspaceId: "ws_123",
    isInternal: false,
    isMain: false,
    workspace: {
      isMain: false,
      unPriceCustomerId: null,
    },
  },
}

beforeEach(() => {
  authMocks.keyAuth.mockResolvedValue(verifiedKey)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("replayIngestionEventsV1 route", () => {
  it("re-enqueues only latest failed replayable Tinybird rows", async () => {
    const rows = [
      createReplayRow({ canonical_audit_id: "audit_1", payload_json: createPayloadJson() }),
      createReplayRow({
        event_id: "evt_456",
        canonical_audit_id: "audit_2",
        payload_json: createPayloadJson({
          id: "evt_456",
          idempotencyKey: "idem_456",
        }),
      }),
    ]
    const { app, analytics, env, executionCtx } = createTestApp(rows)

    const response = await app.fetch(
      buildRequest({ canonical_audit_ids: ["audit_1", "audit_2"] }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ replayed: 2, skipped: 0 })
    expect(analytics.getIngestionReplayPayloads).toHaveBeenCalledWith({
      project_id: "proj_123",
      canonical_audit_ids: "audit_1,audit_2",
    })
    expect(env.QUEUE_SHARD_0.send).toHaveBeenCalledTimes(2)
    expect(env.QUEUE_SHARD_0.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: "evt_123",
        idempotencyKey: "idem_123",
        projectId: "proj_123",
        requestId: "req_123",
      })
    )
    expect(env.QUEUE_SHARD_0.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: "evt_456",
        idempotencyKey: "idem_456",
        projectId: "proj_123",
        requestId: "req_123",
      })
    )
  })

  it("skips canonical ids that are no longer failed or replayable", async () => {
    const { app, env, executionCtx } = createTestApp([
      createReplayRow({ canonical_audit_id: "audit_1", payload_json: createPayloadJson() }),
    ])

    const response = await app.fetch(
      buildRequest({ canonical_audit_ids: ["audit_1", "audit_2"] }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ replayed: 1, skipped: 1 })
    expect(env.QUEUE_SHARD_0.send).toHaveBeenCalledTimes(1)
  })

  it("dedupes canonical ids before querying Tinybird", async () => {
    const { app, analytics, env, executionCtx } = createTestApp([])

    const response = await app.fetch(
      buildRequest({ canonical_audit_ids: ["audit_1", "audit_1"] }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ replayed: 0, skipped: 1 })
    expect(analytics.getIngestionReplayPayloads).toHaveBeenCalledWith({
      project_id: "proj_123",
      canonical_audit_ids: "audit_1",
    })
    expect(env.QUEUE_SHARD_0.send).not.toHaveBeenCalled()
  })

  it("allows a main API key to replay a requested project", async () => {
    authMocks.keyAuth.mockResolvedValueOnce({
      ...verifiedKey,
      project: {
        ...verifiedKey.project,
        isMain: true,
        workspace: {
          ...verifiedKey.project.workspace,
          isMain: true,
        },
      },
    })
    const { app, analytics, env, executionCtx } = createTestApp([
      createReplayRow({
        canonical_audit_id: "audit_1",
        payload_json: createPayloadJson({ projectId: "proj_dashboard" }),
      }),
    ])

    const response = await app.fetch(
      buildRequest({
        canonical_audit_ids: ["audit_1"],
        project_id: "proj_dashboard",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ replayed: 1, skipped: 0 })
    expect(authMocks.keyAuth).toHaveBeenCalledTimes(1)
    expect(analytics.getIngestionReplayPayloads).toHaveBeenCalledWith({
      project_id: "proj_dashboard",
      canonical_audit_ids: "audit_1",
    })
    expect(env.QUEUE_SHARD_0.send).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_dashboard",
        requestId: "req_123",
      })
    )
  })

  it("rejects project override when the API key is not main", async () => {
    const { app, analytics, env, executionCtx } = createTestApp([
      createReplayRow({ canonical_audit_id: "audit_1", payload_json: createPayloadJson() }),
    ])

    const response = await app.fetch(
      buildRequest({
        canonical_audit_ids: ["audit_1"],
        project_id: "proj_other",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      code: "FORBIDDEN",
      message: "You are not allowed to access a different project.",
    })
    expect(analytics.getIngestionReplayPayloads).not.toHaveBeenCalled()
    expect(env.QUEUE_SHARD_0.send).not.toHaveBeenCalled()
  })

  it("does not enqueue any messages when a later payload belongs to a different project", async () => {
    const { app, env, executionCtx } = createTestApp([
      createReplayRow({
        canonical_audit_id: "audit_1",
        payload_json: createPayloadJson(),
      }),
      createReplayRow({
        canonical_audit_id: "audit_2",
        payload_json: createPayloadJson({ projectId: "proj_other" }),
      }),
    ])

    const response = await app.fetch(
      buildRequest({ canonical_audit_ids: ["audit_1", "audit_2"] }),
      env,
      executionCtx
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: "BAD_REQUEST",
      message: "Replay payload project does not match request project",
    })
    expect(env.QUEUE_SHARD_0.send).not.toHaveBeenCalled()
  })

  it("does not enqueue any messages when a later payload is invalid", async () => {
    const { app, env, executionCtx } = createTestApp([
      createReplayRow({
        canonical_audit_id: "audit_1",
        payload_json: createPayloadJson(),
      }),
      createReplayRow({
        canonical_audit_id: "audit_2",
        payload_json: JSON.stringify({ version: 1 }),
      }),
    ])

    const response = await app.fetch(
      buildRequest({ canonical_audit_ids: ["audit_1", "audit_2"] }),
      env,
      executionCtx
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: "BAD_REQUEST",
      message: "Replay payload is not a valid ingestion queue message",
    })
    expect(env.QUEUE_SHARD_0.send).not.toHaveBeenCalled()
  })

  it("maps malformed payload_json to an error without queue sends", async () => {
    const { app, env, executionCtx } = createTestApp([
      createReplayRow({
        canonical_audit_id: "audit_1",
        payload_json: "{not-json",
      }),
    ])

    const response = await app.fetch(
      buildRequest({ canonical_audit_ids: ["audit_1"] }),
      env,
      executionCtx
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: "BAD_REQUEST",
      message: "Replay payload is not valid JSON",
    })
    expect(env.QUEUE_SHARD_0.send).not.toHaveBeenCalled()
  })

  it("retries and logs queue send failures consistently with raw ingest", async () => {
    vi.useFakeTimers()
    const { app, env, executionCtx, logger } = createTestApp([
      createReplayRow({ canonical_audit_id: "audit_1", payload_json: createPayloadJson() }),
    ])
    env.QUEUE_SHARD_0.send.mockRejectedValue(new Error("queue down"))

    const responsePromise = app.fetch(
      buildRequest({ canonical_audit_ids: ["audit_1"] }),
      env,
      executionCtx
    )
    await vi.runAllTimersAsync()
    const response = await responsePromise

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to enqueue ingestion event",
    })
    expect(env.QUEUE_SHARD_0.send).toHaveBeenCalledTimes(3)
    expect(logger.warn).toHaveBeenCalledTimes(3)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})

function createTestApp(rows: ReplayPayloadRow[]) {
  const app = new OpenAPIHono<HonoEnv>()
  const logger = createRouteLogger()
  const analytics = {
    getIngestionReplayPayloads: vi.fn().mockResolvedValue({ data: rows }),
  }

  app.use(timing())

  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }

    throw error
  })

  app.use("*", async (c, next) => {
    c.set("requestId", "req_123")
    c.set("requestStartedAt", Date.now())
    c.set("logger", logger as Logger)
    c.set("analytics", analytics as unknown as Analytics)

    await next()
  })

  registerReplayIngestionEventsV1(app)

  const env = {
    QUEUE_SHARD_0: {
      send: vi.fn().mockResolvedValue(undefined),
    },
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, analytics, env, executionCtx, logger }
}

function buildRequest(
  body: { canonical_audit_ids: string[]; project_id?: string },
  opts: {
    includeBearer?: boolean
  } = {}
) {
  const headers = new Headers({
    "content-type": "application/json",
  })

  if (opts.includeBearer !== false) {
    headers.set("authorization", "Bearer sk_test")
  }

  return new Request("https://example.com/v1/ingestion-events/replay", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

function createPayloadJson(overrides: Partial<IngestionQueueMessage> = {}) {
  return JSON.stringify(createMessage(overrides))
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
    properties: {
      amount: 42,
    },
    source: {
      environment: "development",
      apiKeyId: "key_123",
      sourceType: "api_key",
      sourceId: "key_123",
      sourceName: null,
    },
    ...overrides,
  }
}

function createReplayRow(overrides: Partial<ReplayPayloadRow> = {}): ReplayPayloadRow {
  return {
    event_id: "evt_123",
    canonical_audit_id: "audit_1",
    customer_id: "cus_123",
    failure_stage: "rating_fact",
    failure_reason: "raw_ingestion_queue_processing_failed",
    payload_json: createPayloadJson(),
    handled_at: Date.UTC(2026, 2, 18, 10, 0, 0),
    ...overrides,
  }
}

function createRouteLogger(): Pick<Logger, "error" | "warn" | "set"> {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    set: vi.fn(),
  }
}

type ReplayPayloadRow = {
  event_id: string
  canonical_audit_id: string
  customer_id: string
  failure_stage: string | null
  failure_reason: string | null
  payload_json: string
  handled_at: number
}
