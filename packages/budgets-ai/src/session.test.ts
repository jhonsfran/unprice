import { Unprice } from "@unprice/budgets"
import { describe, expect, it } from "vitest"
import { type BudgetSessionOptions, createBudgetSession, usageCost } from "./index"

const pricing = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }
const limits = { context: 1_000_000, output: 4096 }
/**
 * The generation body is 139 bytes and one message, so the bound is 139 + 8 + 32 = 179 tokens at
 * the highest input rate (cacheWrite, 1.25), plus 32 output tokens at 2: 0.00028775.
 */
const HOLD = 0.00028775

function fixture(
  overrides: Partial<BudgetSessionOptions> = {},
  denied = false,
  options: { rejectAboveHold?: boolean } = {}
) {
  const order: string[] = []
  const amounts: number[] = []
  const payloads: Record<string, unknown>[] = []
  const records: Record<string, unknown>[] = []
  const client = new Unprice({
    token: "test",
    retry: { attempts: 0 },
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>
      if (request.url.endsWith("/record")) {
        order.push("record")
        amounts.push(Number(body.amount))
        records.push(body)
        return Response.json({
          amount: body.amount,
          crossed: ["day"],
          replayed: false,
          created: false,
          balance: { remaining: "-0.0007", held: "0", limits: [] },
        })
      }
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
      if (options.rejectAboveHold && Number(body.amount) > HOLD) {
        return Response.json(
          {
            error: {
              code: "CONFLICT",
              message: "Hold h_1 permits less",
              docs: "",
              requestId: "test",
              details: {
                kind: "hold_amount_exceeded",
                holdId: "h_1",
                maximum: String(HOLD),
                actual: body.amount,
              },
            },
          },
          { status: 409 }
        )
      }
      return Response.json({
        holdId: "h_1",
        actual: body.amount,
        released: "0",
        expired: false,
        crossed: [],
        replayed: false,
        balance: { remaining: "0.5", held: "0", limits: [] },
      })
    },
  })
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    payloads.push((await request.json()) as Record<string, unknown>)
    order.push(request.url.endsWith("/input_tokens") ? "count" : "generate")
    return Response.json({})
  }
  const session = createBudgetSession({
    getBudget: () => client.budget("customer"),
    model: { id: "model", pricing, limits },
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
  return { session, dispatch, order, amounts, payloads, records }
}

describe("shared AI budget request", () => {
  it("bounds the input by its bytes, preserves the smaller cap and JSON mode, and settles once", async () => {
    const test = fixture()
    await test.dispatch()
    await test.session.settle(0.00001)
    await test.session.settle(0.00002)
    expect(test.order).toEqual(["authorize", "generate", "settle"])
    expect(test.amounts).toEqual([HOLD, 0.00001])
    expect(test.payloads).toEqual([
      {
        model: "model",
        input: "Hello",
        max_output_tokens: 32,
        service_tier: "default",
        background: false,
        truncation: "disabled",
        stream: false,
      },
    ])
  })

  it("denies without dispatching generation", async () => {
    const test = fixture({}, true)
    await expect(test.dispatch()).rejects.toThrow("Budget exceeded")
    expect(test.order).toEqual(["authorize"])
    expect(test.session.authorized).toBe(false)
    expect(test.session.error).toBeInstanceOf(Error)
  })

  it("charges the maximum when usage is unknown", async () => {
    const test = fixture()
    await test.dispatch()
    await test.session.settle()
    expect(test.amounts).toEqual([HOLD, HOLD])
  })

  it("rejects a second physical generation dispatch", async () => {
    const test = fixture()
    await test.dispatch()
    await expect(test.dispatch()).rejects.toThrow("one generation")
    expect(test.order).toEqual(["authorize", "generate"])
  })

  it("does not lower a known actual cost to fit its reservation", async () => {
    const test = fixture()
    await test.dispatch()
    const settled = await test.session.settle(0.001)
    expect(test.amounts).toEqual([HOLD, 0.001])
    expect(settled).toEqual({
      holdId: "h_1",
      hold: String(HOLD),
      actual: "0.001",
      exceeded: false,
      balance: { remaining: "0.5", held: "0", limits: [] },
    })
  })

  it("settles the hold in full and records the excess when usage exceeds the reservation", async () => {
    const test = fixture({}, false, { rejectAboveHold: true })
    await test.dispatch()
    const settled = await test.session.settle(0.001)
    expect(test.order).toEqual(["authorize", "generate", "settle", "settle", "record"])
    expect(test.amounts).toEqual([HOLD, 0.001, HOLD, 0.00071225])
    expect(test.records).toEqual([
      {
        key: "customer",
        amount: "0.00071225",
        idempotencyKey: "h_1:excess",
        occurredAt: expect.any(Number),
      },
    ])
    expect(settled).toEqual({
      holdId: "h_1",
      hold: String(HOLD),
      actual: "0.001",
      exceeded: true,
      balance: { remaining: "-0.0007", held: "0", limits: [] },
    })
    expect(test.session.reserved?.hold.id).toBe("h_1")
  })

  it("snapshots rates before dispatch", async () => {
    const rates = { ...pricing }
    const test = fixture({ model: { id: "model", pricing: rates, limits } })
    rates.output = 100
    await test.dispatch()
    expect(test.amounts).toEqual([HOLD])
  })

  it("clamps the output cap to the model's output limit", async () => {
    const test = fixture({ model: { id: "model", pricing, limits: { ...limits, output: 16 } } })
    await test.dispatch()
    expect(test.payloads[0]?.max_output_tokens).toBe(16)
    // 179 × 1.25 + 16 × 2, in millionths, rounded up at eight decimals.
    expect(test.amounts).toEqual([0.00025575])
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
      expect(() =>
        fixture({ model: { id: "model", pricing: { ...pricing, input }, limits } })
      ).toThrow("pricing")
    }
  )

  it.each([0, 15, 16.5])("rejects invalid output cap %s", (maxOutputTokens) => {
    expect(() => fixture({ maxOutputTokens })).toThrow("maxOutputTokens")
  })

  it.each([
    { context: 0, output: 4096 },
    { context: 0.5, output: 4096 },
    { context: 1000, output: 15 },
    { context: 1000, output: Number.POSITIVE_INFINITY },
  ])("rejects model limits %j", (invalid) => {
    expect(() => fixture({ model: { id: "model", pricing, limits: invalid } })).toThrow(
      "model limits"
    )
  })
})

describe("pricing tier configuration", () => {
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects tier threshold %s before dispatch",
    (inputTokensAbove) => {
      expect(() =>
        fixture({
          model: {
            id: "model",
            pricing: { ...pricing, tiers: [{ ...pricing, inputTokensAbove }] },
            limits,
          },
        })
      ).toThrow("threshold")
    }
  )
})
