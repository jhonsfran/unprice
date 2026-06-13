import { OpenAPIHono } from "@hono/zod-openapi"
import { formatMoney } from "@unprice/money"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
}))

vi.mock("~/auth/key", () => ({
  keyAuth: authMocks.keyAuth,
}))

import { registerGetAnalyticsUsageV1 } from "./getUsageV1"

const verifiedKey = {
  id: "key_123",
  projectId: "proj_123",
  project: {
    id: "proj_123",
    workspaceId: "ws_123",
    defaultCurrency: "EUR",
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
})

describe("getUsageV1 route", () => {
  it("returns usage with customer-facing spending", async () => {
    const { app, env, executionCtx, getFeaturesUsagePeriod } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        customer_id: "cus_123",
        project_id: "proj_123",
        range: "24h",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      usage: [
        {
          project_id: "proj_123",
          customer_id: "cus_123",
          feature_slug: "events",
          usage: 10000,
          spending: {
            amount: "0",
            currency: "EUR",
            display_amount: formatMoney("0", "EUR"),
          },
        },
      ],
    })
    expect(getFeaturesUsagePeriod).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_id: "cus_123",
        project_id: "proj_123",
      })
    )
  })

  it("falls back for pre-rollout Tinybird usage rows", async () => {
    const { app, env, executionCtx } = createTestApp({
      rows: [
        {
          project_id: "proj_123",
          customer_id: "cus_123",
          feature_slug: "events",
          value_after: 10000,
        },
      ],
    })

    const response = await app.fetch(
      buildRequest({
        customer_id: "cus_123",
        project_id: "proj_123",
        range: "24h",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      usage: [
        {
          project_id: "proj_123",
          customer_id: "cus_123",
          feature_slug: "events",
          usage: 10000,
          spending: {
            amount: "0",
            currency: "EUR",
            display_amount: formatMoney("0", "EUR"),
          },
        },
      ],
    })
  })

  it("logs Tinybird query context before returning an API error", async () => {
    const tinybirdError = new Error("connect ECONNREFUSED 127.0.0.1:7181")
    const { app, env, executionCtx, loggerError } = createTestApp({
      analyticsError: tinybirdError,
    })

    const response = await app.fetch(
      buildRequest({
        customer_id: "cus_123",
        project_id: "proj_123",
        range: "24h",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(500)
    expect(loggerError).toHaveBeenCalledWith(
      "analytics usage tinybird query failed",
      expect.objectContaining({
        error: expect.objectContaining({
          message: "connect ECONNREFUSED 127.0.0.1:7181",
          type: "Error",
        }),
        error_message: "connect ECONNREFUSED 127.0.0.1:7181",
        pipe: "v1_get_feature_usage_period",
        project_id: "proj_123",
        customer_id: "cus_123",
        range: "24h",
      })
    )
  })
})

function createTestApp(
  options: {
    rows?: Array<Record<string, unknown>>
    analyticsError?: Error
  } = {}
) {
  const app = new OpenAPIHono<HonoEnv>()
  const getFeaturesUsagePeriod = vi.fn().mockImplementation(async () => {
    if (options.analyticsError) {
      throw options.analyticsError
    }

    return {
      data: options.rows ?? [
        {
          project_id: "proj_123",
          customer_id: "cus_123",
          feature_slug: "events",
          usage: 10000,
          amount_after: 0,
          currency: "EUR",
        },
      ],
    }
  })
  const loggerError = vi.fn()
  const swr = vi.fn(async (_key: string, loader: () => Promise<unknown>) => {
    try {
      return {
        err: undefined,
        val: await loader(),
      }
    } catch (error) {
      return {
        err: error,
        val: undefined,
      }
    }
  })

  app.use(timing())

  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }

    throw error
  })

  app.use("*", async (c, next) => {
    c.set("analytics", {
      getFeaturesUsagePeriod,
    })
    c.set("cache", {
      getUsage: {
        swr,
      },
    })
    c.set("logger", {
      set: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: loggerError,
      flush: vi.fn(),
    })

    await next()
  })

  registerGetAnalyticsUsageV1(app)

  const env = {
    APP_ENV: "development",
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx, getFeaturesUsagePeriod, swr, loggerError }
}

function buildRequest(body: Record<string, unknown>) {
  return new Request("https://example.com/v1/analytics/usage/get", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}
