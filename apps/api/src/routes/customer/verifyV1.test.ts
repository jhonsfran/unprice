import { OpenAPIHono } from "@hono/zod-openapi"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
  resolveContextProjectId: vi.fn(),
}))

vi.mock("~/auth/key", () => ({
  keyAuth: authMocks.keyAuth,
  resolveContextProjectId: authMocks.resolveContextProjectId,
}))

import { registerVerifyV1 } from "./verifyV1"

const verifiedKey = {
  id: "key_123",
  projectId: "proj_123",
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

describe("verifyV1 route", () => {
  it("returns the current usage state for a usage feature", async () => {
    vi.useFakeTimers()
    const requestStartedAt = Date.UTC(2026, 2, 21, 12, 0, 0)
    vi.setSystemTime(new Date(requestStartedAt))

    const { app, env, executionCtx, verifyFeatureStatus } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        customerId: "cus_123",
        featureSlug: "api_calls",
        timestamp: requestStartedAt,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      allowed: true,
      effectiveAt: requestStartedAt,
      expiresAt: null,
      featureSlug: "api_calls",
      featureType: "usage",
      isLimitReached: false,
      limit: 100,
      meterConfig: {
        aggregationField: "amount",
        aggregationMethod: "sum",
        eventId: "meter_123",
        eventSlug: "tokens_used",
      },
      overageStrategy: "none",
      status: "usage",
      timestamp: requestStartedAt,
      usage: 42,
    })
    expect(verifyFeatureStatus).toHaveBeenCalledWith({
      customerId: "cus_123",
      featureSlug: "api_calls",
      projectId: "proj_123",
      timestamp: requestStartedAt,
    })
  })

  it("falls back to the request start time when timestamp is omitted", async () => {
    vi.useFakeTimers()
    const requestStartedAt = Date.UTC(2026, 2, 21, 12, 0, 0)
    vi.setSystemTime(new Date(requestStartedAt))

    const { app, env, executionCtx, verifyFeatureStatus } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        customerId: "cus_123",
        featureSlug: "api_calls",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    expect(verifyFeatureStatus).toHaveBeenCalledWith({
      customerId: "cus_123",
      featureSlug: "api_calls",
      projectId: "proj_123",
      timestamp: requestStartedAt,
    })
  })
})

function createTestApp(
  options: {
    resolveCustomerId?: ReturnType<typeof vi.fn>
    verifyFeatureStatus?: ReturnType<typeof vi.fn>
  } = {}
) {
  const app = new OpenAPIHono<HonoEnv>()
  const verifyFeatureStatus =
    options.verifyFeatureStatus ??
    vi.fn().mockResolvedValue({
      allowed: true,
      effectiveAt: Date.UTC(2026, 2, 21, 12, 0, 0),
      expiresAt: null,
      featureSlug: "api_calls",
      featureType: "usage",
      isLimitReached: false,
      limit: 100,
      meterConfig: {
        aggregationField: "amount",
        aggregationMethod: "sum",
        eventId: "meter_123",
        eventSlug: "tokens_used",
      },
      overageStrategy: "none",
      status: "usage",
      timestamp: Date.UTC(2026, 2, 21, 12, 0, 0),
      usage: 42,
    })
  const resolveCustomerId =
    options.resolveCustomerId ??
    vi.fn().mockResolvedValue({
      val: {
        customerId: "cus_123",
        projectId: "proj_123",
      },
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
      customer: {
        resolveCustomerId,
      },
      ingestion: {
        verifyFeatureStatus,
      },
    })

    await next()
  })

  registerVerifyV1(app)

  const env = {
    APP_ENV: "development",
    MAIN_PROJECT_ID: undefined,
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx, resolveCustomerId, verifyFeatureStatus }
}

function buildRequest(body: Record<string, unknown>) {
  return new Request("https://example.com/v1/customer/verify", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}
