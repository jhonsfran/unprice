import { OpenAPIHono } from "@hono/zod-openapi"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

vi.mock("ulid", () => ({
  ulid: vi.fn(() => "01ARYZ6S41TSV4RRFFQ69G5FAV"),
}))

vi.mock("@unprice/lakehouse", () => ({
  getLakehouseSourceCurrentVersion: vi.fn(() => 1),
  parseLakehouseEvent: vi.fn((_source: string, payload: unknown) => payload),
}))

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
  resolveContextProjectId: vi.fn(),
}))

vi.mock("~/auth/key", () => ({
  keyAuth: authMocks.keyAuth,
  resolveContextProjectId: authMocks.resolveContextProjectId,
}))

import { registerIngestEventsSyncV1 } from "./ingestEventsSyncV1"

const requestBody = {
  id: "evt_123",
  idempotencyKey: "idem_123",
  eventSlug: "tokens_used",
  featureSlug: "api_calls",
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

describe("ingestEventsSyncV1 route", () => {
  it("returns the synchronous ingestion result for the targeted feature", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, ingestFeatureSync } = createTestApp()

    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      allowed: true,
      state: "processed",
    })
    expect(ingestFeatureSync).toHaveBeenCalledWith({
      featureSlug: "api_calls",
      message: expect.objectContaining({
        id: "evt_123",
        idempotencyKey: "idem_123",
        slug: "tokens_used",
      }),
    })
  })

  it("uses the request start time when the event timestamp is omitted", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, ingestFeatureSync } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        timestamp: undefined,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    expect(ingestFeatureSync).toHaveBeenCalledWith({
      featureSlug: "api_calls",
      message: expect.objectContaining({
        timestamp: requestBody.timestamp,
      }),
    })
  })

  it("resolves customer id from key binding when request customerId is omitted", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, ingestFeatureSync } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        customerId: undefined,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    expect(ingestFeatureSync).toHaveBeenCalledWith({
      featureSlug: "api_calls",
      message: expect.objectContaining({
        customerId: verifiedKey.defaultCustomerId,
      }),
    })
  })

  it("uses explicit customerId from body even when key has a different default", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(requestBody.timestamp))

    const { app, env, executionCtx, ingestFeatureSync } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        ...requestBody,
        customerId: "cus_explicit_999",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    expect(ingestFeatureSync).toHaveBeenCalledWith({
      featureSlug: "api_calls",
      message: expect.objectContaining({
        customerId: "cus_explicit_999",
      }),
    })
  })

  it("returns 400 when customerId is omitted and key has no default binding", async () => {
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
  const ingestFeatureSync = vi.fn().mockResolvedValue({
    allowed: true,
    state: "processed",
  })

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
    c.set("services", {
      ingestion: {
        ingestFeatureSync,
      },
    })

    await next()
  })

  registerIngestEventsSyncV1(app)

  const env = {
    APP_ENV: "development",
    MAIN_PROJECT_ID: undefined,
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx, ingestFeatureSync }
}

function buildRequest(body: Record<string, unknown> = requestBody) {
  return new Request("https://example.com/v1/events/ingest/sync", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}
