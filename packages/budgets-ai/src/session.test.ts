import { Unprice } from "@unprice/budgets"
import { describe, expect, it } from "vitest"
import { type BudgetSessionOptions, createBudgetSession, usageCost } from "./index"

const pricing = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }

function fixture(
  overrides: Partial<Extract<BudgetSessionOptions, { protocol?: "openai-responses" }>> = {},
  denied = false
) {
  const order: string[] = []
  const amounts: number[] = []
  const payloads: Record<string, unknown>[] = []
  const client = new Unprice({
    token: "test",
    retry: { attempts: 0 },
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>
      if (request.url.endsWith("/authorize")) {
        order.push("authorize")
        amounts.push(Number(body.amount))
        if (denied)
          return Response.json(
            {
              error: {
                code: "BUDGET_EXCEEDED",
                message: "No budget",
                docs: "",
                requestId: "test",
                details: {
                  kind: "budget_exceeded",
                  blocked: {
                    limitId: "day",
                    window: "day",
                    remaining: "0",
                    held: "0",
                    resetsAt: 1,
                    remedy: "wait_for_reset",
                  },
                  balance: { remaining: "0", held: "0", limits: [] },
                },
              },
            },
            { status: 409 }
          )
        return Response.json({
          holdId: "h_1",
          amount: body.amount,
          expiresAt: Date.now() + 300_000,
          replayed: false,
          balance: { remaining: "1", held: body.amount, limits: [] },
        })
      }
      order.push("settle")
      amounts.push(Number(body.amount))
      return Response.json({})
    },
  })
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    payloads.push((await request.json()) as Record<string, unknown>)
    if (request.url.endsWith("/input_tokens")) {
      order.push("count")
      return Response.json({ object: "response.input_tokens", input_tokens: 20 })
    }
    order.push("generate")
    return Response.json({})
  }
  const session = createBudgetSession({
    getBudget: () => client.budget("customer"),
    modelId: "model",
    pricing,
    maxOutputTokens: 4096,
    mode: "generate",
    fetch: transport,
    ...overrides,
  })
  const dispatch = () =>
    session.fetch("https://provider.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model", input: "Hello", max_output_tokens: 32 }),
    })
  return { session, dispatch, order, amounts, payloads }
}

describe("shared AI budget request", () => {
  it("counts the final request, preserves the smaller cap and JSON mode, and settles once", async () => {
    const test = fixture()
    await test.dispatch()
    await test.session.settle(0.00001)
    await test.session.settle(0.00002)
    expect(test.order).toEqual(["count", "authorize", "generate", "settle"])
    expect(test.amounts).toEqual([0.000089, 0.00001])
    expect(test.payloads[1]).toMatchObject({
      max_output_tokens: 32,
      stream: false,
      service_tier: "default",
      background: false,
      truncation: "disabled",
    })
    expect(test.payloads[0]?.input).toBe(test.payloads[1]?.input)
  })

  it("denies without dispatching generation", async () => {
    const test = fixture({}, true)
    await expect(test.dispatch()).rejects.toThrow("Budget exceeded")
    expect(test.order).toEqual(["count", "authorize"])
    expect(test.session.authorized).toBe(false)
    expect(test.session.error).toBeInstanceOf(Error)
  })

  it("charges the maximum when usage is unknown", async () => {
    const test = fixture()
    await test.dispatch()
    await test.session.settle()
    expect(test.amounts).toEqual([0.000089, 0.000089])
  })

  it("rejects a second physical generation dispatch", async () => {
    const test = fixture()
    await test.dispatch()
    await expect(test.dispatch()).rejects.toThrow("one generation")
    expect(test.order).toEqual(["count", "authorize", "generate"])
  })

  it("does not lower a known actual cost to fit its reservation", async () => {
    const test = fixture()
    await test.dispatch()
    await test.session.settle(0.001)
    expect(test.amounts).toEqual([0.000089, 0.001])
  })

  it("snapshots rates before dispatch", async () => {
    const rates = { ...pricing }
    const test = fixture({ pricing: rates })
    rates.output = 100
    await test.dispatch()
    expect(test.amounts).toEqual([0.000089])
  })

  it("prices cached input once and includes reasoning in output once", () => {
    expect(usageCost(pricing, { input: 80, cacheRead: 20, cacheWrite: 0, output: 10 })).toBeCloseTo(
      0.000102,
      10
    )
  })

  it("selects whole-request pricing tiers by total input", () => {
    expect(
      usageCost(
        { ...pricing, tiers: [{ ...pricing, output: 4, inputTokensAbove: 99 }] },
        { input: 80, cacheRead: 20, cacheWrite: 0, output: 10 }
      )
    ).toBeCloseTo(0.000122, 10)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid configured rate %s",
    (input) => {
      expect(() => fixture({ pricing: { ...pricing, input } })).toThrow("pricing")
    }
  )

  it.each([0, 15, 16.5])("rejects invalid output cap %s", (maxOutputTokens) => {
    expect(() => fixture({ maxOutputTokens })).toThrow("maxOutputTokens")
  })
})

describe("pricing tier configuration", () => {
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects tier threshold %s before dispatch",
    (inputTokensAbove) => {
      expect(() =>
        fixture({ pricing: { ...pricing, tiers: [{ ...pricing, inputTokensAbove }] } })
      ).toThrow("threshold")
    }
  )
})
