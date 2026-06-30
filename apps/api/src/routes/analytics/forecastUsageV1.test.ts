import { OpenAPIHono } from "@hono/zod-openapi"
import type { ExecutionContext } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
}))

vi.mock("~/auth/key", () => ({
  keyAuth: authMocks.keyAuth,
}))

import { registerForecastUsageV1 } from "./forecastUsageV1"

const DAY_MS = 86_400_000
const now = 1_780_000_000_000
const observationEnd = Math.floor(now / DAY_MS) * DAY_MS
const observationStart = observationEnd - 14 * DAY_MS

const verifiedKey = {
  id: "key_123",
  projectId: "proj_123",
  project: {
    id: "proj_123",
    workspaceId: "ws_123",
    defaultCurrency: "USD",
    isInternal: false,
    isMain: false,
    workspace: {
      isMain: false,
      unPriceCustomerId: null,
    },
  },
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  authMocks.keyAuth.mockResolvedValue(verifiedKey)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe("forecastUsageV1 route", () => {
  it("returns a structured usage projection from recent daily Tinybird aggregates", async () => {
    const usageByDay = Array.from({ length: 14 }, (_, index) => 10 * (index + 1))
    const { app, env, executionCtx, getFeaturesUsagePeriod } = createTestApp({ usageByDay })

    const response = await app.fetch(
      buildRequest({
        customer_id: "cus_123",
        feature_slug: "tokens",
        period_key: "month:2026-06",
        horizon_days: 14,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      answer:
        "Projected incremental usage of 140 units for tokens over the next 14 days for customer cus_123. This is a projection, not a prediction.",
      confidence: "high",
      freshness: {
        generatedAt: now,
        dataFrom: observationStart,
        dataTo: observationEnd,
      },
      evidence: Array.from({ length: 13 }, (_, index) => ({
        type: "meter_fact",
        id: `proj_123:cus_123:tokens:month:2026-06:${dayKey(
          observationStart + (index + 1) * DAY_MS
        )}`,
        source: "tinybird",
        timestamp: observationStart + (index + 2) * DAY_MS,
      })),
      warnings: [
        "This is a projection of incremental horizon usage from day-over-day cumulative usage deltas, not a prediction.",
      ],
      nextActions: ["Compare this projection against entitlement limits and wallet runway."],
      project_id: "proj_123",
      customer_id: "cus_123",
      feature_slug: "tokens",
      horizonDays: 14,
      projectedUsage: 140,
      observedDays: 13,
      baselineUsage: 10,
      trendPerDay: 0,
      periodKey: "month:2026-06",
    })
    expect(getFeaturesUsagePeriod).toHaveBeenCalledTimes(14)
    expect(getFeaturesUsagePeriod).toHaveBeenNthCalledWith(1, {
      project_id: "proj_123",
      customer_id: "cus_123",
      feature_slugs: ["tokens"],
      start: observationStart,
      end: observationStart + DAY_MS,
      period_key: "month:2026-06",
    })
  })

  it("defaults horizon_days and omits period_key from Tinybird queries", async () => {
    const usageByDay = Array.from<number | null>({ length: 14 }).fill(null)
    usageByDay[11] = 4
    usageByDay[12] = 5
    usageByDay[13] = 6
    const { app, env, executionCtx, getFeaturesUsagePeriod } = createTestApp({ usageByDay })

    const response = await app.fetch(
      buildRequest({
        customer_id: "cus_sparse",
        feature_slug: "tokens",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual(
      expect.objectContaining({
        confidence: "low",
        observedDays: 2,
        horizonDays: 14,
        warnings: [
          "This is a projection of incremental horizon usage from day-over-day cumulative usage deltas, not a prediction.",
          "Fewer than five observed days were available, so confidence is low.",
        ],
        nextActions: ["Collect at least five days of usage before relying on the projection."],
      })
    )
    expect(body.evidence).toHaveLength(2)
    expect(getFeaturesUsagePeriod).toHaveBeenNthCalledWith(1, {
      project_id: "proj_123",
      customer_id: "cus_sparse",
      feature_slugs: ["tokens"],
      start: observationStart,
      end: observationStart + DAY_MS,
    })
  })

  it("maps Tinybird failures to API errors", async () => {
    const { app, env, executionCtx } = createTestApp({
      usageByDay: [],
      error: new Error("tinybird unavailable"),
    })

    const response = await app.fetch(
      buildRequest({
        customer_id: "cus_error",
        feature_slug: "tokens",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "INTERNAL_SERVER_ERROR",
        message: "tinybird unavailable",
      })
    )
  })
})

function createTestApp({
  usageByDay,
  error,
}: {
  usageByDay: Array<number | null>
  error?: Error
}) {
  const app = new OpenAPIHono<HonoEnv>()
  const getFeaturesUsagePeriod = vi.fn(
    async (query: {
      project_id: string
      customer_id: string
      feature_slugs?: string[]
      start?: number
      end?: number
      period_key?: string
    }) => {
      if (error) {
        throw error
      }

      const dayIndex =
        typeof query.start === "number" ? Math.floor((query.start - observationStart) / DAY_MS) : -1
      const usage = usageByDay[dayIndex]

      return {
        data:
          typeof usage === "number"
            ? [
                {
                  project_id: query.project_id,
                  customer_id: query.customer_id,
                  feature_slug: query.feature_slugs?.[0] ?? "tokens",
                  usage,
                  amount_after: 0,
                  currency: "USD",
                },
              ]
            : [],
      }
    }
  )

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

    await next()
  })

  registerForecastUsageV1(app)

  const env = {
    APP_ENV: "development",
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx, getFeaturesUsagePeriod }
}

function buildRequest(body: Record<string, unknown>) {
  return new Request("https://example.com/v1/analytics/usage/forecast", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}
