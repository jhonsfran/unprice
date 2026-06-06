import { OpenAPIHono } from "@hono/zod-openapi"
import type { ExecutionContext } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
    const usageByDay = Array.from({ length: 14 }, (_, index) => 10 + index)
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
        "Projected 427 usage units for tokens over the next 14 days for customer cus_123. This is a projection, not a prediction.",
      confidence: "high",
      freshness: {
        generatedAt: now,
        dataFrom: now - 14 * DAY_MS,
        dataTo: now,
      },
      evidence: Array.from({ length: 14 }, (_, index) => ({
        type: "meter_fact",
        id: `proj_123:cus_123:tokens:${now - 14 * DAY_MS + index * DAY_MS}:${
          now - 14 * DAY_MS + (index + 1) * DAY_MS
        }`,
        source: "tinybird",
        timestamp: now - 14 * DAY_MS + (index + 1) * DAY_MS,
      })),
      warnings: ["This is a projection based on recent aggregate usage, not a prediction."],
      nextActions: ["Compare this projection against entitlement limits and wallet runway."],
      project_id: "proj_123",
      customer_id: "cus_123",
      feature_slug: "tokens",
      horizonDays: 14,
      projectedUsage: 427,
      observedDays: 14,
      baselineUsage: 16.5,
      trendPerDay: 1,
      periodKey: "month:2026-06",
    })
    expect(getFeaturesUsagePeriod).toHaveBeenCalledTimes(14)
    expect(getFeaturesUsagePeriod).toHaveBeenNthCalledWith(1, {
      project_id: "proj_123",
      customer_id: "cus_123",
      feature_slugs: ["tokens"],
      start: now - 14 * DAY_MS,
      end: now - 13 * DAY_MS,
      period_key: "month:2026-06",
    })
  })

  it("returns low confidence when fewer than five observed days are available", async () => {
    const usageByDay = Array.from<number | null>({ length: 14 }).fill(null)
    usageByDay[11] = 4
    usageByDay[12] = 5
    usageByDay[13] = 6
    const { app, env, executionCtx } = createTestApp({ usageByDay })

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
        observedDays: 3,
        horizonDays: 14,
        warnings: [
          "This is a projection based on recent aggregate usage, not a prediction.",
          "Fewer than five observed days were available, so confidence is low.",
        ],
        nextActions: ["Collect at least five days of usage before relying on the projection."],
      })
    )
    expect(body.evidence).toHaveLength(3)
  })
})

function createTestApp({ usageByDay }: { usageByDay: Array<number | null> }) {
  const app = new OpenAPIHono<HonoEnv>()
  const observationStart = now - 14 * DAY_MS
  const getFeaturesUsagePeriod = vi.fn(
    async (query: {
      project_id: string
      customer_id: string
      feature_slugs?: string[]
      start?: number
      end?: number
      period_key?: string
    }) => {
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
  return new Request("https://example.com/v1/analytics/forecast-usage", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}
