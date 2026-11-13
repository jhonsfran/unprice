import { OpenAPIHono } from "@hono/zod-openapi"
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

import { registerGetIngestionStatusV1 } from "./getIngestionStatusV1"

const fromTs = 1_780_000_000_000
const toTs = 1_780_000_010_000
const now = 1_780_000_006_500

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

describe("getIngestionStatusV1 route", () => {
  it("answers a customer's status from the budget journal, scoped to the key's project", async () => {
    const { app, env, executionCtx, queries } = createTestApp((sql) =>
      sql.includes("SELECT state, COUNT(*)")
        ? [
            {
              state: "processed",
              events: 2,
              last_seen_at: new Date(fromTs + 1_000).toISOString(),
            },
          ]
        : []
    )

    const response = await app.fetch(
      buildRequest({
        customer_id: "cus_123",
        from_ts: fromTs,
        to_ts: toTs,
        event_slug: "tokens",
        state: "processed",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      window: { from: fromTs, to: toTs },
      totals: { processed: 2, rejected: 0, total: 2 },
      successRate: 1,
      confidence: "high",
    })
    // totals, timeline, rejections, recent events, and facets
    expect(queries).toHaveLength(5)
    for (const sql of queries) {
      expect(sql).toContain("WHERE project_id = 'proj_123'")
      expect(sql).toContain("AND budget_key = 'unprice:customer:cus_123'")
      expect(sql).toContain("event_slug IN ('tokens')")
      expect(sql).toContain("state IN ('processed')")
    }
  })

  it("reads every payer budget of the project when customer_id is omitted", async () => {
    const { app, env, executionCtx, queries } = createTestApp(() => [])

    const response = await app.fetch(
      buildRequest({ from_ts: fromTs, to_ts: toTs }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      totals: { processed: 0, rejected: 0, total: 0 },
      confidence: "low",
    })
    expect(queries[0]).toContain("AND starts_with(budget_key, 'unprice:customer:')")
  })

  it("rejects invalid windows before auth", async () => {
    const { app, env, executionCtx, queries } = createTestApp(() => [])

    const response = await app.fetch(
      buildRequest({ customer_id: "cus_invalid", from_ts: toTs, to_ts: fromTs }),
      env,
      executionCtx
    )

    expect(response.status).toBe(400)
    expect(authMocks.keyAuth).not.toHaveBeenCalled()
    expect(queries).toEqual([])
  })

  it("rejects the removed queue failure state before auth", async () => {
    const { app, env, executionCtx, queries } = createTestApp(() => [])

    const response = await app.fetch(
      buildRequest({ from_ts: fromTs, to_ts: toTs, state: "failed" }),
      env,
      executionCtx
    )

    expect(response.status).toBe(400)
    expect(authMocks.keyAuth).not.toHaveBeenCalled()
    expect(queries).toEqual([])
  })

  it("maps journal failures to internal server errors", async () => {
    const { app, env, executionCtx } = createTestApp(() => new Error("basin unavailable"))

    const response = await app.fetch(
      buildRequest({ customer_id: "cus_123", from_ts: fromTs, to_ts: toTs }),
      env,
      executionCtx
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "INTERNAL_SERVER_ERROR" })
    )
  })
})

function createTestApp(answer: (sql: string) => unknown[] | Error) {
  const app = new OpenAPIHono<HonoEnv>()
  const { budgetJournal, queries } = journalAnalytics(answer)

  app.use(timing())

  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }

    throw error
  })

  app.use("*", async (c, next) => {
    c.set("services", { budgetJournal } as unknown as HonoEnv["Variables"]["services"])
    await next()
  })

  registerGetIngestionStatusV1(app)

  const env = { APP_ENV: "development" }
  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx, queries }
}

function buildRequest(body: Record<string, unknown>) {
  return new Request("https://example.com/v1/ingestion-events/status", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}
