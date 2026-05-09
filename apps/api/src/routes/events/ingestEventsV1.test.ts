import { OpenAPIHono } from "@hono/zod-openapi"
import { INGESTION_MAX_EVENT_AGE_MS } from "@unprice/services/entitlements"
import type { IngestionQueueMessage } from "@unprice/services/ingestion"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

vi.mock("ulid", () => ({
  ulid: vi.fn(() => "01ARYZ6S41TSV4RRFFQ69G5FAV"),
}))

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
  resolveContextProjectId: vi.fn(),
}))

vi.mock("~/auth/key", () => ({
  keyAuth: authMocks.keyAuth,
  resolveContextProjectId: authMocks.resolveContextProjectId,
}))

import type { AppLogger } from "@unprice/observability"
import type { ExecutionContext } from "hono"
import {
  generateEventId,
  registerIngestEventsV1,
  safeSendToQueue,
  selectQueueShardIndex,
} from "./ingestEventsV1"

const requestBody = {
  id: "evt_123",
  idempotencyKey: "idem_123",
  eventSlug: "tokens_used",
  customerId: "cus_123",
  timestamp: Date.UTC(2026, 2, 18, 10, 0, 0),
  properties: {
    amount: 42,
  },
}

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
      unPriceCustomerId: null,
    },
  },
}

beforeEach(() => {
  authMocks.keyAuth.mockResolvedValue(verifiedKey)
  authMocks.resolveContextProjectId.mockImplementation(
    async (_c: unknown, defaultProjectId: string) => defaultProjectId
  )
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("ingestEventsV1 helpers", () => {
  it("selects the same shard for the same customer", () => {
    expect(selectQueueShardIndex("cus_123")).toBe(selectQueueShardIndex("cus_123"))
  })

  it("generates a stable ulid-like event id shape", () => {
    expect(generateEventId(requestBody.timestamp)).toBe("evt_01ARYZ6S41TSV4RRFFQ69G5FAV")
  })

  it("retries queue send and logs an error when all attempts fail", async () => {
    const queue: Pick<Queue<IngestionQueueMessage>, "send"> = {
      send: vi.fn().mockRejectedValue(new Error("queue down")),
    }
    const logger: Pick<AppLogger, "error" | "warn"> = {
      error: vi.fn(),
      warn: vi.fn(),
    }

    await safeSendToQueue({
      logger,
      queue: queue as Queue<IngestionQueueMessage>,
      message: {
        version: 1,
        projectId: "proj_123",
        customerId: "cus_123",
        requestId: "req_123",
        receivedAt: Date.now(),
        idempotencyKey: "idem_123",
        id: "evt_123",
        slug: "tokens_used",
        timestamp: Date.now(),
        properties: {},
      },
    })

    expect(queue.send).toHaveBeenCalledTimes(3)
    expect(logger.warn).toHaveBeenCalledTimes(3)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})

describe("ingestEventsV1 route", () => {
  it("returns 202 and enqueues on the selected shard when allowed", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, waitUntilPromises } = createTestApp()

    const response = await app.fetch(buildRequest(), env, executionCtx)
    await Promise.all(waitUntilPromises)

    expect(response.status).toBe(202)

    const selectedQueue =
      selectQueueShardIndex(requestBody.customerId) === 0 ? env.QUEUE_SHARD_0 : env.QUEUE_SHARD_1
    const otherQueue = selectedQueue === env.QUEUE_SHARD_0 ? env.QUEUE_SHARD_1 : env.QUEUE_SHARD_0

    expect(selectedQueue.send).toHaveBeenCalledTimes(1)
    expect(selectedQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: requestBody.idempotencyKey,
        projectId: "proj_123",
        requestId: "req_123",
        receivedAt: requestBody.timestamp,
      })
    )
    expect(otherQueue.send).not.toHaveBeenCalled()
  })

  it("uses the request start time when the raw event timestamp is omitted", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, waitUntilPromises } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: undefined,
      }),
      env,
      executionCtx
    )
    await Promise.all(waitUntilPromises)

    expect(response.status).toBe(202)

    const selectedQueue =
      selectQueueShardIndex(requestBody.customerId) === 0 ? env.QUEUE_SHARD_0 : env.QUEUE_SHARD_1

    expect(selectedQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp: requestBody.timestamp,
      })
    )
  })

  it("returns 400 when idempotencyKey is omitted", async () => {
    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        idempotencyKey: undefined,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(400)
  })

  it("returns 400 when the raw event timestamp is too far in the future", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: requestBody.timestamp + 5_000,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "BAD_REQUEST",
      })
    )
  })

  it("returns 400 when the raw event timestamp is older than the max accepted age", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, logger } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: requestBody.timestamp - INGESTION_MAX_EVENT_AGE_MS - 1,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "BAD_REQUEST",
      })
    )
    expect(logger.warn).toHaveBeenCalledWith(
      "raw ingestion event rejected as too old",
      expect.objectContaining({
        projectId: "proj_123",
        customerId: requestBody.customerId,
        idempotencyKey: requestBody.idempotencyKey,
        rejectionReason: "EVENT_TOO_OLD",
      })
    )
  })

  it("uses the resolved context project id in the queued ingestion message", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))
    authMocks.resolveContextProjectId.mockResolvedValue("proj_resolved_456")

    const { app, env, executionCtx, waitUntilPromises } = createTestApp()

    const response = await app.fetch(buildRequest(), env, executionCtx)
    await Promise.all(waitUntilPromises)

    expect(response.status).toBe(202)

    const selectedQueue =
      selectQueueShardIndex(requestBody.customerId) === 0 ? env.QUEUE_SHARD_0 : env.QUEUE_SHARD_1

    expect(selectedQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_resolved_456",
      })
    )
  })

  it("generates an internal event id when the request id is omitted", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, waitUntilPromises } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        id: undefined,
      }),
      env,
      executionCtx
    )
    await Promise.all(waitUntilPromises)

    expect(response.status).toBe(202)

    const selectedQueue =
      selectQueueShardIndex(requestBody.customerId) === 0 ? env.QUEUE_SHARD_0 : env.QUEUE_SHARD_1

    expect(selectedQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: requestBody.idempotencyKey,
        id: "evt_01ARYZ6S41TSV4RRFFQ69G5FAV",
      })
    )
  })

  it("resolves customer id from the API key binding when omitted in the request", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, waitUntilPromises } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        customerId: undefined,
      }),
      env,
      executionCtx
    )
    await Promise.all(waitUntilPromises)

    expect(response.status).toBe(202)

    const selectedQueue =
      selectQueueShardIndex(verifiedKey.defaultCustomerId) === 0
        ? env.QUEUE_SHARD_0
        : env.QUEUE_SHARD_1

    expect(selectedQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: verifiedKey.defaultCustomerId,
      })
    )
  })

  it("uses explicit customerId from body even when key has a different default", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, waitUntilPromises } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        customerId: "cus_explicit_999",
      }),
      env,
      executionCtx
    )
    await Promise.all(waitUntilPromises)

    expect(response.status).toBe(202)

    const selectedQueue =
      selectQueueShardIndex("cus_explicit_999") === 0 ? env.QUEUE_SHARD_0 : env.QUEUE_SHARD_1

    expect(selectedQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_explicit_999",
      })
    )
  })

  it("returns 400 when customerId is omitted and the api key has no default customer", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))
    authMocks.keyAuth.mockResolvedValueOnce({
      ...verifiedKey,
      defaultCustomerId: null,
    })

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        customerId: undefined,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "BAD_REQUEST",
        message: "customerId is required when the API key has no default customer binding",
      })
    )
  })
})

function createTestApp() {
  const app = new OpenAPIHono<HonoEnv>()
  const waitUntilPromises: Promise<unknown>[] = []
  const logger = createRouteLogger()

  app.use(timing())

  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      const status = error.code === "RATE_LIMITED" ? 429 : 400
      return c.json({ code: error.code, message: error.message }, status)
    }

    throw error
  })

  app.use("*", async (c, next) => {
    c.set("requestId", "req_123")
    c.set("requestStartedAt", Date.now())
    c.set("logger", logger as AppLogger)
    c.set("services", {
      logger,
    })

    await next()
  })

  registerIngestEventsV1(app)

  const env = {
    APP_ENV: "development",
    MAIN_PROJECT_ID: undefined,
    QUEUE_SHARD_0: {
      send: vi.fn().mockResolvedValue(undefined),
    },
    QUEUE_SHARD_1: {
      send: vi.fn().mockResolvedValue(undefined),
    },
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise)
    },
  } as unknown as ExecutionContext

  return { app, env, executionCtx, logger, waitUntilPromises }
}

function buildRequest(body: Record<string, unknown> = requestBody) {
  return new Request("https://example.com/v1/events/ingest", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function createRouteLogger(): Pick<AppLogger, "error" | "warn" | "set"> {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    set: vi.fn(),
  }
}
