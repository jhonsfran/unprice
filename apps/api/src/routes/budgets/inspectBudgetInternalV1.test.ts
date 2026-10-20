import { OpenAPIHono } from "@hono/zod-openapi"
import { Err, Ok } from "@unprice/error"
import { type BudgetInspection, UnPriceBudgetError } from "@unprice/services/budgets"
import type { ExecutionContext } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import { handleError, handleZodError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { internalKeyAuth } from "~/middleware/internal-key"
import { registerInspectBudgetInternalV1 } from "./inspectBudgetInternalV1"

const mocks = vi.hoisted(() => ({ keyAuth: vi.fn(), inspect: vi.fn(), log: vi.fn() }))

vi.mock("~/auth/key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/auth/key")>()),
  keyAuth: mocks.keyAuth,
}))

vi.mock("~/ingestion/budget/client", () => ({
  CloudflareBudgetClient: class {
    inspect = mocks.inspect
  },
}))

const keyOf = (project: { isMain: boolean; isInternal: boolean }) => ({
  id: "key_1",
  projectId: "proj_main",
  project: { id: "proj_main", workspaceId: "ws_1", ...project },
})

const usd = (value: number) => BigInt(value) * BigInt(100_000_000)

const hold = {
  kind: "hold",
  id: "h_7",
  idempotencyKey: "job-7",
  amount: usd(5),
  ttlMs: null,
  createdAt: 1_796_083_000_000,
  expiresAt: 1_796_083_900_000,
  state: { status: "open" },
} as const

const inspection: BudgetInspection = {
  budget: {
    key: "customer:acme",
    unit: "money:USD",
    version: 3,
    limits: [{ id: "month", window: "month", enforce: "hard", amount: usd(50) }],
    holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
    onUnavailable: "deny",
    closesAt: null,
    closed: false,
    balance: {
      remaining: usd(44),
      held: usd(5),
      limits: [
        {
          id: "month",
          window: "month",
          enforce: "hard",
          amount: usd(50),
          consumed: usd(1),
          held: usd(5),
          remaining: usd(44),
          resetsAt: 1_798_761_600_000,
        },
      ],
      asOf: 1_796_083_200_000,
    },
    operations: {
      upsert: 3,
      authorize: 1,
      settle: 0,
      release: 0,
      charge: 0,
      record: 1,
      lease: 0,
      report: 0,
    },
  },
  history: [],
  expiringNext: { rows: [hold], examined: 2, next: null },
  listed: usd(5),
  closedRecently: [
    {
      kind: "record",
      id: "o:evt-1",
      idempotencyKey: "evt-1",
      amount: usd(1),
      createdAt: 1_796_083_100_000,
      crossed: [],
    },
  ],
  found: hold,
  probe: { amount: usd(2), blocked: null },
}

afterEach(() => {
  vi.clearAllMocks()
})

function call(body: unknown) {
  const app = new OpenAPIHono<HonoEnv>({ defaultHook: handleZodError })
  app.onError(handleError)
  app.use("*", async (c, next) => {
    c.set("requestId", "req_test")
    c.set("logger", { set: mocks.log } as unknown as HonoEnv["Variables"]["logger"])
    await next()
  })
  app.use("/v1/internal/*", internalKeyAuth())
  registerInspectBudgetInternalV1(app)
  return app.fetch(
    new Request("https://example.com/v1/internal/budgets/inspect", {
      method: "POST",
      headers: { authorization: "Bearer key", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { APP_ENV: "development" },
    { passThroughOnException: vi.fn(), waitUntil: vi.fn() } as unknown as ExecutionContext
  )
}

const body = {
  projectId: "proj_tenant",
  key: "customer:acme",
  find: { by: "hold", holdId: "h_7" },
  probe: "2",
}

describe("POST /v1/internal/budgets/inspect", () => {
  it("rejects a tenant key with 403 before reaching the budget", async () => {
    mocks.keyAuth.mockResolvedValue(keyOf({ isMain: false, isInternal: false }))

    const response = await call(body)

    expect(response.status).toBe(403)
    expect(mocks.inspect).not.toHaveBeenCalled()
  })

  it("inspects the body's project with a main-project key and answers on the wire", async () => {
    mocks.keyAuth.mockResolvedValue(keyOf({ isMain: true, isInternal: false }))
    mocks.inspect.mockResolvedValue(Ok(inspection))

    const response = await call(body)

    expect(response.status).toBe(200)
    expect(mocks.inspect).toHaveBeenCalledWith(
      { projectId: "proj_tenant", key: "customer:acme" },
      { find: { by: "hold", holdId: "h_7" }, probe: usd(2) }
    )
    const wireHold = { ...hold, amount: "5" }
    expect(await response.json()).toEqual({
      budget: {
        key: "customer:acme",
        unit: "money:USD",
        version: 3,
        limits: [{ id: "month", window: "month", enforce: "hard", amount: "50" }],
        holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
        onUnavailable: "deny",
        closesAt: null,
        closed: false,
        balance: {
          remaining: "44",
          held: "5",
          limits: [
            {
              id: "month",
              window: "month",
              enforce: "hard",
              amount: "50",
              consumed: "1",
              held: "5",
              remaining: "44",
              resetsAt: 1_798_761_600_000,
            },
          ],
          asOf: 1_796_083_200_000,
        },
        operations: inspection.budget.operations,
      },
      history: [],
      expiringNext: { rows: [wireHold], examined: 2, next: null },
      listed: "5",
      closedRecently: [
        {
          kind: "record",
          id: "o:evt-1",
          idempotencyKey: "evt-1",
          amount: "1",
          createdAt: 1_796_083_100_000,
          crossed: [],
        },
      ],
      found: wireHold,
      probe: { amount: "2", blocked: null },
    })
    expect(mocks.log).toHaveBeenCalledWith({
      budget: { command: "inspect", outcome: "ok", do_ms: expect.any(Number) },
    })
  })

  it("answers 404 when the key has no budget", async () => {
    mocks.keyAuth.mockResolvedValue(keyOf({ isMain: false, isInternal: true }))
    mocks.inspect.mockResolvedValue(Err(new UnPriceBudgetError({ code: "BUDGET_NOT_FOUND" })))

    const response = await call({ projectId: "proj_tenant", key: "customer:gone" })

    expect(response.status).toBe(404)
    expect(mocks.inspect).toHaveBeenCalledWith(
      { projectId: "proj_tenant", key: "customer:gone" },
      {}
    )
  })
})
