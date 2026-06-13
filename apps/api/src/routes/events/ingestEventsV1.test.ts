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

import type { Logger } from "@unprice/logs"
import type { ExecutionContext } from "hono"
import {
  INGESTION_TEST_FAILURE_HEADER,
  INGESTION_TEST_FAILURE_RAW_PROCESSING_VALUE,
  generateEventId,
  registerIngestEventsV1,
  resolveIngestionMessageRequestId,
  resolveLakehouseBucket,
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

  it("retries queue send and throws when all attempts fail", async () => {
    const queue: Pick<Queue<IngestionQueueMessage>, "send"> = {
      send: vi.fn().mockRejectedValue(new Error("queue down")),
    }
    const logger: Pick<Logger, "error" | "warn"> = {
      error: vi.fn(),
      warn: vi.fn(),
    }

    await expect(
      safeSendToQueue({
        logger,
        queue: queue as Queue<IngestionQueueMessage>,
        message: {
          version: 1,
          workspaceId: "ws_123",
          projectId: "proj_123",
          customerId: "cus_123",
          requestId: "req_123",
          receivedAt: Date.now(),
          idempotencyKey: "idem_123",
          id: "evt_123",
          slug: "tokens_used",
          timestamp: Date.now(),
          properties: {},
          source: {
            environment: "development",
            apiKeyId: "key_123",
            sourceType: "api_key",
            sourceId: "key_123",
            sourceName: null,
          },
        },
      })
    ).rejects.toBeInstanceOf(UnpriceApiError)

    expect(queue.send).toHaveBeenCalledTimes(3)
    expect(logger.warn).toHaveBeenCalledTimes(3)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it("resolves preview lakehouse writes to the dev bucket binding", () => {
    const devBucket = createR2Bucket()

    expect(
      resolveLakehouseBucket({
        APP_ENV: "preview",
        unprice_lakehouse_dev: devBucket as unknown as R2Bucket,
      })
    ).toEqual({
      bucket: devBucket,
      bucketName: "unprice-lakehouse-dev",
    })
  })

  it("resolves development lakehouse writes without the prod bucket binding", () => {
    const devBucket = createR2Bucket()

    expect(
      resolveLakehouseBucket({
        APP_ENV: "development",
        unprice_lakehouse_dev: devBucket as unknown as R2Bucket,
      })
    ).toEqual({
      bucket: devBucket,
      bucketName: "unprice-lakehouse-dev",
    })
  })

  it("resolves production lakehouse writes to the prod bucket binding", () => {
    const prodBucket = createR2Bucket()

    expect(
      resolveLakehouseBucket({
        APP_ENV: "production",
        unprice_lakehouse_prod: prodBucket as unknown as R2Bucket,
      })
    ).toEqual({
      bucket: prodBucket,
      bucketName: "unprice-lakehouse-prod",
    })
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
  it("returns 202 and enqueues on the selected shard when allowed", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: Date.now(),
      }),
      env,
      executionCtx
    )
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
        workspaceId: "ws_123",
        rawStorage: {
          bucketName: "unprice-lakehouse-dev",
          objectKey: "ingestion/raw/development/proj_123/cus_123/idem_123/evt_123.json",
        },
        source: {
          environment: "development",
          apiKeyId: "key_123",
          sourceType: "api_key",
          sourceId: "key_123",
          sourceName: null,
        },
      })
    )
    expect(otherQueue.send).not.toHaveBeenCalled()
  })

  it("marks accepted non-production messages for raw processing failure tests", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx } = createTestApp()

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

    const selectedQueue =
      selectQueueShardIndex(requestBody.customerId) === 0 ? env.QUEUE_SHARD_0 : env.QUEUE_SHARD_1

    expect(selectedQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "test:raw_ingestion_queue_processing_failed:req_123",
      })
    )
  })

  it("writes the accepted raw payload before enqueueing", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: Date.now(),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(202)

    const expectedObjectKey = "ingestion/raw/development/proj_123/cus_123/idem_123/evt_123.json"

    expect(env.unprice_lakehouse_dev.put).toHaveBeenCalledTimes(1)
    expect(env.unprice_lakehouse_dev.put).toHaveBeenCalledWith(
      expectedObjectKey,
      expect.stringContaining('"rawStorage"'),
      expect.objectContaining({
        onlyIf: {
          etagDoesNotMatch: "*",
        },
        httpMetadata: {
          contentType: "application/json",
        },
      })
    )
    expect(env.QUEUE_SHARD_0.send).toHaveBeenCalledTimes(1)
    expect(env.QUEUE_SHARD_0.send).toHaveBeenCalledWith(
      expect.objectContaining({
        rawStorage: {
          bucketName: "unprice-lakehouse-dev",
          objectKey: expectedObjectKey,
        },
      })
    )

    const putCallOrder = env.unprice_lakehouse_dev.put.mock.invocationCallOrder[0]
    const sendCallOrder = env.QUEUE_SHARD_0.send.mock.invocationCallOrder[0]

    if (putCallOrder === undefined || sendCallOrder === undefined) {
      throw new Error("expected R2 put and queue send to be invoked")
    }

    expect(putCallOrder).toBeLessThan(sendCallOrder)
  })

  it("does not overwrite an existing raw payload and still enqueues", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx } = createTestApp()
    env.unprice_lakehouse_dev.put.mockResolvedValueOnce(null)

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: Date.now(),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(202)

    const expectedObjectKey = "ingestion/raw/development/proj_123/cus_123/idem_123/evt_123.json"

    expect(env.unprice_lakehouse_dev.put).toHaveBeenCalledWith(
      expectedObjectKey,
      expect.stringContaining('"rawStorage"'),
      expect.objectContaining({
        onlyIf: {
          etagDoesNotMatch: "*",
        },
      })
    )
    expect(env.QUEUE_SHARD_0.send).toHaveBeenCalledWith(
      expect.objectContaining({
        rawStorage: {
          bucketName: "unprice-lakehouse-dev",
          objectKey: expectedObjectKey,
        },
      })
    )
  })

  it("does not enqueue when raw payload persistence fails", async () => {
    const { app, env, executionCtx, logger } = createTestApp()
    env.unprice_lakehouse_dev.put.mockRejectedValueOnce(new Error("r2 down"))

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: Date.now(),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(400)
    expect(env.QUEUE_SHARD_0.send).not.toHaveBeenCalled()
    expect(env.QUEUE_SHARD_1.send).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      "raw ingestion payload persistence failed",
      expect.objectContaining({
        error: expect.objectContaining({
          message: "r2 down",
          type: "Error",
        }),
        error_message: "r2 down",
      })
    )
  })

  it("uses the request start time when the raw event timestamp is omitted", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: undefined,
      }),
      env,
      executionCtx
    )
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

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: Date.now(),
      }),
      env,
      executionCtx
    )
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

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        id: undefined,
      }),
      env,
      executionCtx
    )
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

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        customerId: undefined,
      }),
      env,
      executionCtx
    )
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

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        customerId: "cus_explicit_999",
      }),
      env,
      executionCtx
    )
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

  it("does not return 202 when queue send fails permanently after retries", async () => {
    const { app, env, executionCtx } = createTestApp()
    env.QUEUE_SHARD_0.send = vi.fn().mockRejectedValue(new Error("queue down"))
    env.QUEUE_SHARD_1.send = vi.fn().mockRejectedValue(new Error("queue down"))

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: Date.now(),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "INTERNAL_SERVER_ERROR",
      })
    )

    const selectedQueue =
      selectQueueShardIndex(requestBody.customerId) === 0 ? env.QUEUE_SHARD_0 : env.QUEUE_SHARD_1
    expect(selectedQueue.send).toHaveBeenCalledTimes(3)
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
    c.set("logger", logger as Logger)
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
    QUEUE_SHARD_0: {
      send: vi.fn().mockResolvedValue(undefined),
    },
    QUEUE_SHARD_1: {
      send: vi.fn().mockResolvedValue(undefined),
    },
    unprice_lakehouse_dev: {
      put: vi.fn().mockResolvedValue(null),
    },
    unprice_lakehouse_prod: undefined,
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise)
    },
  } as unknown as ExecutionContext

  return { app, env, executionCtx, logger, waitUntilPromises }
}

function buildRequest(
  body: Record<string, unknown> = requestBody,
  headers: Record<string, string> = {}
) {
  return new Request("https://example.com/v1/events/ingest", {
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

function createR2Bucket() {
  return {
    put: vi.fn().mockResolvedValue(null),
  }
}
