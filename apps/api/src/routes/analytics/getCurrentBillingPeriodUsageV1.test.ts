import { OpenAPIHono } from "@hono/zod-openapi"
import { formatMoney } from "@unprice/money"
import type * as UseCasesModule from "@unprice/services/use-cases"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
}))

const useCaseMocks = vi.hoisted(() => ({
  getCurrentBillingPeriodUsage: vi.fn(),
}))

vi.mock("~/auth/key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/auth/key")>()
  return { ...actual, keyAuth: authMocks.keyAuth }
})

vi.mock("@unprice/services/use-cases", async (importOriginal) => {
  const actual = await importOriginal<typeof UseCasesModule>()
  return {
    ...actual,
    getCurrentBillingPeriodUsage: useCaseMocks.getCurrentBillingPeriodUsage,
  }
})

import { BillingPeriodUsageCoverageError } from "@unprice/services/use-cases"
import { registerGetCurrentBillingPeriodUsageV1 } from "./getCurrentBillingPeriodUsageV1"

const now = Date.UTC(2026, 7, 2, 9, 0, 0)
const verifiedKey = {
  id: "key_123",
  projectId: "proj_123",
  defaultCustomerId: null,
  project: {
    id: "proj_123",
    workspaceId: "ws_123",
    defaultCurrency: "USD",
    isInternal: false,
    isMain: false,
    workspace: { isMain: false, unPriceCustomerId: null },
  },
}

beforeEach(() => {
  authMocks.keyAuth.mockResolvedValue(verifiedKey)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("getCurrentBillingPeriodUsageV1 route", () => {
  it("formats the canonical use-case result", async () => {
    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(buildRequest({ customer_id: "cus_123" }), env, executionCtx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      billing_periods: [
        {
          billing_period_id: "bp_current",
          cycle_start_at: now - 86_400_000,
          cycle_end_at: now + 2_505_600_000,
          usage: [
            {
              feature_slug: "tokens",
              usage: 5_100,
              spending: {
                amount: "0.051",
                currency: "USD",
                display_amount: formatMoney("0.051", "USD"),
              },
            },
          ],
        },
      ],
    })
    expect(useCaseMocks.getCurrentBillingPeriodUsage).toHaveBeenCalledWith(
      expect.objectContaining({ now: expect.any(Function) }),
      {
        projectId: "proj_123",
        customerId: "cus_123",
      }
    )
    const deps = useCaseMocks.getCurrentBillingPeriodUsage.mock.calls[0]?.[0]
    expect(deps.now()).toBe(now)
  })

  it("returns an empty result from the use case unchanged", async () => {
    const { app, env, executionCtx } = createTestApp({ billingPeriods: [] })

    const response = await app.fetch(buildRequest({ customer_id: "cus_123" }), env, executionCtx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ billing_periods: [] })
  })

  it("logs a use-case failure before returning an API error", async () => {
    const analyticsError = new Error("analytics unavailable")
    const { app, env, executionCtx, loggerError } = createTestApp({ analyticsError })

    const response = await app.fetch(buildRequest({ customer_id: "cus_123" }), env, executionCtx)

    expect(response.status).toBe(500)
    expect(loggerError).toHaveBeenCalledWith(
      "current billing-period usage tinybird query failed",
      expect.objectContaining({
        pipe: "v1_get_billing_period_usage",
        project_id: "proj_123",
        customer_id: "cus_123",
      })
    )
  })

  it("returns 412 instead of a partial report before billing-period attribution coverage", async () => {
    const { app, env, executionCtx, loggerWarn } = createTestApp({
      analyticsError: new BillingPeriodUsageCoverageError({
        billingPeriodIds: ["bp_current"],
        customerId: "cus_123",
        projectId: "proj_123",
        start: now - 86_400_000,
        end: now + 2_505_600_000,
      }),
    })

    const response = await app.fetch(buildRequest({ customer_id: "cus_123" }), env, executionCtx)

    expect(response.status).toBe(412)
    await expect(response.json()).resolves.toEqual({
      code: "PRECONDITION_FAILED",
      message:
        "Current billing-period usage is unavailable until pre-attribution usage is migrated.",
    })
    expect(loggerWarn).toHaveBeenCalledWith(
      "current billing-period usage is incomplete before attribution migration",
      expect.objectContaining({
        pipe: "v1_get_billing_period_usage_coverage",
        project_id: "proj_123",
        customer_id: "cus_123",
      })
    )
  })
})

function createTestApp(
  options: {
    analyticsError?: Error
    billingPeriods?: Array<BillingPeriod>
  } = {}
) {
  const app = new OpenAPIHono<HonoEnv>()
  const loggerError = vi.fn()
  const loggerWarn = vi.fn()
  const analytics = { getBillingPeriodUsage: vi.fn() }
  const db = { query: { billingPeriods: { findMany: vi.fn() } } }

  useCaseMocks.getCurrentBillingPeriodUsage.mockImplementation(async () => {
    if (options.analyticsError) return { err: options.analyticsError }

    return {
      val: {
        billingPeriods: options.billingPeriods ?? [billingPeriod()],
      },
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
    c.set("analytics", analytics)
    c.set("db", db)
    c.set("logger", {
      set: vi.fn(),
      debug: vi.fn(),
      warn: loggerWarn,
      error: loggerError,
      flush: vi.fn(),
    })
    c.set("requestId", "req_123")
    c.set("requestStartedAt", now)
    await next()
  })

  registerGetCurrentBillingPeriodUsageV1(app)

  return {
    app,
    env: { APP_ENV: "development" },
    executionCtx: {
      passThroughOnException: vi.fn(),
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext,
    loggerError,
    loggerWarn,
  }
}

type BillingPeriod = {
  cycleEndAt: number
  cycleStartAt: number
  id: string
  usage: Array<{
    amount: number
    currency: string
    featureSlug: string
    usage: number
  }>
}

function billingPeriod(): BillingPeriod {
  return {
    id: "bp_current",
    cycleStartAt: now - 86_400_000,
    cycleEndAt: now + 2_505_600_000,
    usage: [
      {
        featureSlug: "tokens",
        usage: 5_100,
        amount: 5_100_000,
        currency: "USD",
      },
    ],
  }
}

function buildRequest(body: Record<string, unknown>) {
  return new Request("https://example.com/v1/analytics/usage/current-billing-period", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}
