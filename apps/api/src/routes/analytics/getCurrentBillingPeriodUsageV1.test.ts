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

import { UnPriceBudgetError } from "@unprice/services/budgets"
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

  it("labels a credit-unit amount with no currency", async () => {
    const { app, env, executionCtx } = createTestApp({
      billingPeriods: [
        {
          ...billingPeriod(),
          usage: [{ featureSlug: "tokens", usage: 5, amount: "12", unit: "credits:acme" }],
        },
      ],
    })

    const response = await app.fetch(buildRequest({ customer_id: "cus_123" }), env, executionCtx)

    const body = (await response.json()) as {
      billing_periods: Array<{ usage: Array<{ spending: unknown }> }>
    }
    expect(body.billing_periods[0]?.usage[0]?.spending).toEqual({
      amount: "12",
      currency: "XXX",
      display_amount: "12 credits:acme",
    })
  })

  it("maps a payer budget rejection to its API error", async () => {
    const { app, env, executionCtx } = createTestApp({
      failure: new UnPriceBudgetError({ code: "BUDGET_CLOSED", closedAt: now }),
    })

    const response = await app.fetch(buildRequest({ customer_id: "cus_123" }), env, executionCtx)

    expect(response.status).toBe(409)
  })
})

function createTestApp(
  options: {
    failure?: UnPriceBudgetError
    billingPeriods?: Array<BillingPeriod>
  } = {}
) {
  const app = new OpenAPIHono<HonoEnv>()

  useCaseMocks.getCurrentBillingPeriodUsage.mockImplementation(async () => {
    if (options.failure) return { err: options.failure }
    return { val: { billingPeriods: options.billingPeriods ?? [billingPeriod()] } }
  })

  app.use(timing())
  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }
    throw error
  })
  app.use("*", async (c, next) => {
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
  }
}

type BillingPeriod = UseCasesModule.GetCurrentBillingPeriodUsageOutput["billingPeriods"][number]

function billingPeriod(): BillingPeriod {
  return {
    id: "bp_current",
    cycleStartAt: now - 86_400_000,
    cycleEndAt: now + 2_505_600_000,
    usage: [{ featureSlug: "tokens", usage: 5_100, amount: "0.051", unit: "money:USD" }],
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
