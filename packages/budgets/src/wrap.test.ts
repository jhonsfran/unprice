import { describe, expect, it } from "vitest"
import { BudgetExceededError } from "./budgets"
import { Unprice } from "./client"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const balance = { remaining: "4.99", held: "0", limits: [], asOf: 1_792_000_000_000 }

function fixture(options: { denied?: boolean } = {}) {
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
      if (path === "/v1/budgets/charge") {
        if (options.denied) {
          return json(
            {
              error: {
                code: "BUDGET_EXCEEDED",
                message: "Denied",
                requestId: "req_1",
                docs: "https://docs.unprice.dev",
                details: {
                  kind: "budget_exceeded",
                  balance: { ...balance, remaining: "0" },
                  blocked: {
                    limitId: "month",
                    window: "month",
                    remaining: "0",
                    held: "0",
                    resetsAt: 1_800_000_000_000,
                    remedy: "wait_for_reset",
                  },
                },
              },
            },
            402
          )
        }
        return json({
          allowed: true,
          amount: body.amount,
          crossed: [],
          replayed: false,
          created: false,
          balance,
        })
      }
      if (path === "/v1/budgets/lease") {
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
          created: false,
          balance,
        })
      }
      if (path === "/v1/budgets/report") {
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
      }
      throw new Error(`unexpected ${path}`)
    },
  })
  return { unprice, calls }
}

describe("budget.wrap", () => {
  it("charges the price before the tool runs, keyed by the AI SDK tool call id", async () => {
    const { unprice, calls } = fixture()
    const order: string[] = []
    const search = unprice
      .budget("run:r_1")
      .wrap({ amount: 0.01 }, async ({ q }: { q: string }, _options: { toolCallId: string }) => {
        order.push("tool")
        return `found ${q}`
      })
    await expect(search({ q: "x" }, { toolCallId: "call_1" })).resolves.toBe("found x")
    expect(calls).toEqual([
      {
        path: "/v1/budgets/charge",
        body: { key: "run:r_1", amount: "0.01", idempotencyKey: "call_1" },
      },
    ])
    expect(order).toEqual(["tool"])
  })

  it("sends the same charge again when the same tool call runs again", async () => {
    const { unprice, calls } = fixture()
    const lookup = unprice
      .budget("run:r_1")
      .wrap({ amount: 0.01 }, async (input: string, _options: { toolCallId: string }) => input)
    await lookup("a", { toolCallId: "call_7" })
    await lookup("a", { toolCallId: "call_7" })
    expect(calls.map((call) => call.body.idempotencyKey)).toEqual(["call_7", "call_7"])
  })

  it("does not run the tool when the budget denies the charge", async () => {
    const { unprice, calls } = fixture({ denied: true })
    let ran = false
    const search = unprice
      .budget("run:r_1")
      .wrap({ amount: 0.01 }, async (_input: { q: string }, _options: { toolCallId: string }) => {
        ran = true
        return "found"
      })
    await expect(search({ q: "x" }, { toolCallId: "call_1" })).rejects.toBeInstanceOf(
      BudgetExceededError
    )
    expect(ran).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it("uses a fresh key per call outside the AI SDK", async () => {
    const { unprice, calls } = fixture()
    const double = unprice.budget("run:r_1").wrap({ amount: "0.005" }, async (n: number) => n * 2)
    expect(await double(2)).toBe(4)
    expect(await double(3)).toBe(6)
    const keys = calls.map((call) => call.body.idempotencyKey)
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
    expect(calls.map((call) => call.body.amount)).toEqual(["0.005", "0.005"])
  })

  it("charges a local handle from its lease without a request per call", async () => {
    const { unprice, calls } = fixture()
    const budget = unprice.budget("run:r_1", { mode: "local", lease: { amount: 1 } })
    const search = budget.wrap(
      { amount: 0.01 },
      async ({ q }: { q: string }, _options: { toolCallId: string }) => `found ${q}`
    )
    await expect(search({ q: "x" }, { toolCallId: "call_1" })).resolves.toBe("found x")
    await expect(search({ q: "y" }, { toolCallId: "call_2" })).resolves.toBe("found y")
    expect(calls.map((call) => call.path)).toEqual(["/v1/budgets/lease"])
    await unprice.close()
  })
})
