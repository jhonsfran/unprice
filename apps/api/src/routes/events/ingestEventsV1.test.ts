import { OpenAPIHono } from "@hono/zod-openapi"
import { INGESTION_MAX_EVENT_AGE_MS } from "@unprice/services/entitlements"
import type { IngestionQueueMessage, RawIngestionQueueClient } from "@unprice/services/ingestion"
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

vi.mock("~/auth/key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/auth/key")>()
  return {
    ...actual,
    keyAuth: authMocks.keyAuth,
    resolveContextProjectId: authMocks.resolveContextProjectId,
  }
})

import type { Logger } from "@unprice/logs"
import type { ExecutionContext } from "hono"
import {
  INGESTION_TEST_FAILURE_HEADER,
  INGESTION_TEST_FAILURE_RAW_PROCESSING_VALUE,
  RAW_EVENT_MAX_BODY_BYTES,
  RAW_EVENT_MAX_PROPERTIES_BYTES,
  RAW_EVENT_MAX_PROPERTY_DEPTH,
  RAW_EVENT_MAX_PROPERTY_KEYS,
  generateEventId,
  registerIngestEventsV1,
  resolveIngestionMessageRequestId,
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
  defaultCustomerId: "cus_123",
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
  it("generates a stable ulid-like event id shape", () => {
    expect(generateEventId(requestBody.timestamp)).toBe("evt_01ARYZ6S41TSV4RRFFQ69G5FAV")
  })

  it("marks non-production failure-test request ids", () => {
    expect(
      resolveIngestionMessageRequestId({
        appEnv: "development",
        failureTestHeader: INGESTION_TEST_FAILURE_RAW_PROCESSING_VALUE,
        requestId: "req_123",
      })
    ).toBe("test:raw_ingestion_queue_processing_failed:req_123")
  })

  it("ignores failure-test request ids in production", () => {
    expect(
      resolveIngestionMessageRequestId({
        appEnv: "production",
        failureTestHeader: INGESTION_TEST_FAILURE_RAW_PROCESSING_VALUE,
        requestId: "req_123",
      })
    ).toBe("req_123")
  })
})

describe("ingestEventsV1 route", () => {
  it("returns 202 and enqueues when allowed", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, sentMessages } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: Date.now(),
      }),
      env,
      executionCtx
    )
    expect(response.status).toBe(202)

    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]).toEqual(
      expect.objectContaining({
        idempotencyKey: requestBody.idempotencyKey,
        projectId: "proj_123",
        requestId: "req_123",
        receivedAt: requestBody.timestamp,
        workspaceId: "ws_123",
        source: {
          environment: "development",
          apiKeyId: "key_123",
          sourceType: "api_key",
          sourceId: "key_123",
          sourceName: null,
        },
      })
    )
  })

  it("marks accepted non-production messages for raw processing failure tests", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, sentMessages } = createTestApp()

    const response = await app.fetch(
      buildRequest(
        {
          ...requestBody,
          timestamp: Date.now(),
        },
        {
          [INGESTION_TEST_FAILURE_HEADER]: INGESTION_TEST_FAILURE_RAW_PROCESSING_VALUE,
        }
      ),
      env,
      executionCtx
    )
    expect(response.status).toBe(202)

    expect(sentMessages[0]).toEqual(
      expect.objectContaining({
        requestId: "test:raw_ingestion_queue_processing_failed:req_123",
      })
    )
  })

  it("uses the request start time when the raw event timestamp is omitted", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, sentMessages } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: undefined,
      }),
      env,
      executionCtx
    )
    expect(response.status).toBe(202)

    expect(sentMessages[0]).toEqual(
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

  it("returns 413 and skips auth when Content-Length exceeds the raw event body limit", async () => {
    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest(requestBody, {
        "content-length": String(RAW_EVENT_MAX_BODY_BYTES + 1),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "PAYLOAD_TOO_LARGE",
      })
    )
    expect(authMocks.keyAuth).not.toHaveBeenCalled()
  })

  it("returns 413 and skips auth when the raw body exceeds the limit without Content-Length", async () => {
    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      new Request("https://example.com/v1/usage/record", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...requestBody,
          padding: "x".repeat(RAW_EVENT_MAX_BODY_BYTES),
        }),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "PAYLOAD_TOO_LARGE",
      })
    )
    expect(authMocks.keyAuth).not.toHaveBeenCalled()
  })

  it("returns 413 and skips auth when properties exceed the serialized size limit", async () => {
    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        properties: {
          body: "x".repeat(RAW_EVENT_MAX_PROPERTIES_BYTES),
        },
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "PAYLOAD_TOO_LARGE",
        message: `Event properties must be ${RAW_EVENT_MAX_PROPERTIES_BYTES} bytes or less`,
      })
    )
    expect(authMocks.keyAuth).not.toHaveBeenCalled()
  })

  it("returns 413 and skips auth when properties contain too many keys", async () => {
    const { app, env, executionCtx } = createTestApp()
    const properties = Object.fromEntries(
      Array.from({ length: RAW_EVENT_MAX_PROPERTY_KEYS + 1 }, (_, index) => [`key_${index}`, index])
    )

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        properties,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "PAYLOAD_TOO_LARGE",
        message: `Event properties must contain ${RAW_EVENT_MAX_PROPERTY_KEYS} keys or fewer`,
      })
    )
    expect(authMocks.keyAuth).not.toHaveBeenCalled()
  })

  it("returns 413 and skips auth when properties are nested too deeply", async () => {
    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        properties: createNestedProperties(RAW_EVENT_MAX_PROPERTY_DEPTH + 1),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "PAYLOAD_TOO_LARGE",
        message: `Event properties must be nested ${RAW_EVENT_MAX_PROPERTY_DEPTH} levels or fewer`,
      })
    )
    expect(authMocks.keyAuth).not.toHaveBeenCalled()
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

    const { app, env, executionCtx, sentMessages } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: Date.now(),
      }),
      env,
      executionCtx
    )
    expect(response.status).toBe(202)

    expect(sentMessages[0]).toEqual(
      expect.objectContaining({
        projectId: "proj_resolved_456",
      })
    )
  })

  it("generates an internal event id when the request id is omitted", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, sentMessages } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        id: undefined,
      }),
      env,
      executionCtx
    )
    expect(response.status).toBe(202)

    expect(sentMessages[0]).toEqual(
      expect.objectContaining({
        idempotencyKey: requestBody.idempotencyKey,
        id: "evt_01ARYZ6S41TSV4RRFFQ69G5FAV",
      })
    )
  })

  it("resolves customer id from the API key binding when omitted in the request", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, sentMessages } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        customerId: undefined,
      }),
      env,
      executionCtx
    )
    expect(response.status).toBe(202)

    expect(sentMessages[0]).toEqual(
      expect.objectContaining({
        customerId: verifiedKey.defaultCustomerId,
      })
    )
  })

  it("returns 403 when explicit customerId differs from the customer-bound API key", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        customerId: "cus_explicit_999",
      }),
      env,
      executionCtx
    )
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "FORBIDDEN",
        message: "This API key is bound to a different customer",
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

  it("does not return 202 when queue send fails permanently after retries", async () => {
    const { app, env, executionCtx, rawIngestionQueue } = createTestApp()
    rawIngestionQueue.send.mockRejectedValue(new Error("queue down"))

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: Date.now(),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "INTERNAL_SERVER_ERROR",
      })
    )

    expect(rawIngestionQueue.send).toHaveBeenCalledOnce()
  })
})

function createTestApp() {
  const app = new OpenAPIHono<HonoEnv>()
  const waitUntilPromises: Promise<unknown>[] = []
  const logger = createRouteLogger()
  const sentMessages: IngestionQueueMessage[] = []
  const rawIngestionQueue = {
    send: vi.fn<RawIngestionQueueClient["send"]>(async (message) => {
      sentMessages.push(message)
    }),
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
    c.set("rawIngestionQueue", rawIngestionQueue)
    c.set("services", {
      logger,
    })

    await next()
  })

  registerIngestEventsV1(app)

  const env = {
    APP_ENV: "development",
    NODE_ENV: "test",
    MAIN_PROJECT_ID: undefined,
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise)
    },
  } as unknown as ExecutionContext

  return { app, env, executionCtx, logger, rawIngestionQueue, sentMessages, waitUntilPromises }
}

function buildRequest(
  body: Record<string, unknown> = requestBody,
  headers: Record<string, string> = {}
) {
  return new Request("https://example.com/v1/usage/record", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

function createRouteLogger(): Pick<Logger, "error" | "warn" | "set"> {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    set: vi.fn(),
  }
}

function createNestedProperties(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { value: 1 }

  for (let index = 0; index < depth; index++) {
    value = { nested: value }
  }

  return value
}
