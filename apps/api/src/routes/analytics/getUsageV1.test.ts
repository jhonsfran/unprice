import { OpenAPIHono } from "@hono/zod-openapi"
import { formatMoney } from "@unprice/money"
import { journalAnalytics } from "@unprice/services/analytics/journal-fixture"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
}))

vi.mock("~/auth/key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/auth/key")>()

  return {
    ...actual,
    keyAuth: authMocks.keyAuth,
  }
})

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
  it("returns usage per customer and feature from the budget journal", async () => {
    const { app, env, executionCtx, queries } = createTestApp(() => [
      {
        budget_key: "unprice:customer:cus_123",
        feature_slug: "events",
        unit: "money:EUR",
        events: 3,
        quantity: "10000.00000000",
        amount: "1.50000000",
      },
      {
        budget_key: "unprice:customer:cus_123",
        feature_slug: null,
        unit: "money:EUR",
        events: 1,
        quantity: null,
        amount: null,
      },
      {
        budget_key: "unprice:customer:cus_456",
        feature_slug: null,
        unit: "money:EUR",
        events: "2",
        quantity: null,
        amount: null,
      },
    ])

    const response = await app.fetch(
      buildRequest({ customer_id: "cus_123", project_id: "proj_123", range: "24h" }),
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
          spending: { amount: "1.5", currency: "EUR", display_amount: formatMoney("1.5", "EUR") },
        },
      ],
      truncated_events: 3,
    })
    expect(queries[0]).toContain("WHERE project_id = 'proj_123'")
    expect(queries[0]).toContain("AND budget_key = 'unprice:customer:cus_123'")
    expect(queries[0]).toContain("GROUP BY budget_key, feature_slug, unit")
  })

  it("keeps each payer unit instead of relabeling amounts with the key project's currency", async () => {
    const { app, env, executionCtx } = createTestApp(() => [
      {
        budget_key: "unprice:customer:cus_123",
        feature_slug: "events",
        unit: "money:USD",
        events: 1,
        quantity: "10",
        amount: "1",
      },
      {
        budget_key: "unprice:customer:cus_123",
        feature_slug: "events",
        unit: "money:EUR",
        events: 1,
        quantity: "20",
        amount: "2",
      },
      {
        budget_key: "unprice:customer:cus_123",
        feature_slug: "events",
        unit: "credits:tokens",
        events: 1,
        quantity: "30",
        amount: "3",
      },
    ])
    const response = await app.fetch(
      buildRequest({ customer_id: "cus_123", project_id: "proj_123", range: "24h" }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      usage: [
        { usage: 10, spending: { amount: "1", currency: "USD" } },
        { usage: 20, spending: { amount: "2", currency: "EUR" } },
        {
          usage: 30,
          spending: { amount: "3", currency: "XXX", display_amount: "3 credits:tokens" },
        },
      ],
    })
  })

  it("defaults an omitted project_id to the key's project", async () => {
    const { app, env, executionCtx, queries } = createTestApp(() => [])
    const response = await app.fetch(buildRequest({ range: "24h" }), env, executionCtx)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ usage: [], truncated_events: 0 })
    expect(queries[0]).toContain("WHERE project_id = 'proj_123'")
  })

  it("rejects another project before querying the journal", async () => {
    const { app, env, executionCtx, queries } = createTestApp(() => [])
    const response = await app.fetch(
      buildRequest({ range: "24h", project_id: "proj_other" }),
      env,
      executionCtx
    )

    expect(response.status).toBe(403)
    expect(queries).toEqual([])
  })

  it("lets a main-project key select another project's history with its own currency", async () => {
    authMocks.keyAuth.mockResolvedValue({
      ...verifiedKey,
      project: { ...verifiedKey.project, isMain: true },
    })
    const { app, env, executionCtx, queries } = createTestApp(() => [
      {
        budget_key: "unprice:customer:cus_123",
        feature_slug: "events",
        unit: "money:USD",
        events: 1,
        quantity: "10",
        amount: "1",
      },
    ])
    const response = await app.fetch(
      buildRequest({ range: "24h", project_id: "proj_other" }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      usage: [{ project_id: "proj_other", spending: { amount: "1", currency: "USD" } }],
    })
    expect(queries[0]).toContain("WHERE project_id = 'proj_other'")
  })

  it("logs the journal failure before returning an API error", async () => {
    const { app, env, executionCtx, loggerError } = createTestApp(() => new Error("basin down"))

    const response = await app.fetch(
      buildRequest({ customer_id: "cus_123", project_id: "proj_123", range: "24h" }),
      env,
      executionCtx
    )

    expect(response.status).toBe(500)
    expect(loggerError).toHaveBeenCalledWith(
      "analytics usage journal query failed",
      expect.objectContaining({ project_id: "proj_123", customer_id: "cus_123", range: "24h" })
    )
  })
})

function createTestApp(answer: (sql: string) => unknown[] | Error) {
  const app = new OpenAPIHono<HonoEnv>()
  const { budgetJournal, queries } = journalAnalytics(answer)
  const loggerError = vi.fn()
  const swr = vi.fn(async (_key: string, loader: () => Promise<unknown>) => {
    try {
      return { err: undefined, val: await loader() }
    } catch (error) {
      return { err: error, val: undefined }
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
    c.set("services", { budgetJournal } as unknown as HonoEnv["Variables"]["services"])
    c.set("cache", { getUsage: { swr } } as unknown as HonoEnv["Variables"]["cache"])
    c.set("logger", {
      set: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: loggerError,
      flush: vi.fn(),
    } as unknown as HonoEnv["Variables"]["logger"])

    await next()
  })

  registerGetAnalyticsUsageV1(app)

  const env = { APP_ENV: "development" }
  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx, queries, loggerError }
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
