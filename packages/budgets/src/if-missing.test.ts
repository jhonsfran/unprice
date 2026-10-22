import { describe, expect, it } from "vitest"
import type { BudgetDefinitionInput } from "./budgets"
import { Unprice } from "./client"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const ifMissing: BudgetDefinitionInput = {
  unit: "USD",
  limits: [{ amount: "5", window: "month", enforce: "hard" }],
}
const balance = { remaining: "4.95", held: "0.05", limits: [], asOf: 1_792_000_000_000 }

function fixture() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const unprice = new Unprice({
    token: "test",
    baseUrl: "https://budgets.test",
    disableTelemetry: true,
    retry: { attempts: 0 },
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      const body = (await request.json()) as Record<string, unknown>
      calls.push({ path, body })
      switch (path) {
        case "/v1/budgets/authorize":
          return json({
            allowed: true,
            holdId: "h_1",
            amount: body.amount,
            expiresAt: 1_792_000_060_000,
            replayed: false,
            created: true,
            balance,
          })
        case "/v1/budgets/charge":
          return json({ amount: body.amount, crossed: [], replayed: false, created: true, balance })
        case "/v1/budgets/settle":
          return json({
            holdId: "h_1",
            actual: body.amount,
            released: "0",
            expired: false,
            crossed: [],
            replayed: false,
            balance,
          })
        case "/v1/budgets/lease":
          return json({
            lease: {
              leaseKey: body.leaseKey,
              seq: 0,
              granted: body.amount,
              captured: "0",
              expiresAt: Date.now() + 60_000,
              status: "open",
            },
            terms: { holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 }, closesAt: null },
            replayed: false,
            created: true,
            balance,
          })
        case "/v1/budgets/report":
          return json({
            lease: {
              leaseKey: body.leaseKey,
              seq: body.seq,
              granted: "1",
              captured: body.captured,
              expiresAt: Date.now() + 60_000,
              status: body.final ? "closed" : "open",
            },
            terms: { holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 }, closesAt: null },
            extension: { requested: "0", granted: "0" },
            released: "0",
            crossed: [],
            replayed: false,
            balance,
          })
        default:
          throw new Error(`unexpected ${path}`)
      }
    },
  })
  return { unprice, calls }
}

describe("a handle with ifMissing", () => {
  it("sends the definition with authorize and reports that the budget was created", async () => {
    const { unprice, calls } = fixture()
    const budget = unprice.budget("customer:new", { ifMissing })
    const authorized = await budget.authorize({ amount: 0.05, idempotencyKey: "k1" })
    expect(authorized.result).toMatchObject({ allowed: true, created: true })
    expect(calls).toEqual([
      {
        path: "/v1/budgets/authorize",
        body: { key: "customer:new", amount: "0.05", idempotencyKey: "k1", ifMissing },
      },
    ])
  })

  it("sends the definition with charge", async () => {
    const { unprice, calls } = fixture()
    const charged = await unprice
      .budget("customer:new", { ifMissing })
      .charge({ amount: 0.01, idempotencyKey: "c1" })
    expect(charged.result).toMatchObject({ allowed: true, created: true })
    expect(calls[0]?.body).toEqual({
      key: "customer:new",
      amount: "0.01",
      idempotencyKey: "c1",
      ifMissing,
    })
  })

  it("sends the definition through spend", async () => {
    const { unprice, calls } = fixture()
    const value = await unprice
      .budget("customer:new", { ifMissing })
      .spend({ estimate: 0.05, idempotencyKey: "s1" }, async () => ({ value: 42, actual: 0.02 }))
    expect(value).toBe(42)
    expect(calls.map((call) => call.path)).toEqual(["/v1/budgets/authorize", "/v1/budgets/settle"])
    expect(calls[0]?.body.ifMissing).toEqual(ifMissing)
  })

  it("sends the definition with a local lease", async () => {
    const { unprice, calls } = fixture()
    const budget = unprice.budget("customer:new", {
      ifMissing,
      mode: "local",
      lease: { amount: 1 },
    })
    const authorized = await budget.authorize({ amount: 0.05, idempotencyKey: "k1" })
    expect(authorized.result?.allowed).toBe(true)
    expect(calls[0]?.path).toBe("/v1/budgets/lease")
    expect(calls[0]?.body.ifMissing).toEqual(ifMissing)
    await unprice.close()
  })

  it("sends no definition without the option", async () => {
    const { unprice, calls } = fixture()
    const authorized = await unprice
      .budget("customer:old")
      .authorize({ amount: 0.05, idempotencyKey: "k1" })
    expect(authorized.result).toMatchObject({ allowed: true, created: true })
    expect(calls[0]?.body).toEqual({ key: "customer:old", amount: "0.05", idempotencyKey: "k1" })
  })
})
