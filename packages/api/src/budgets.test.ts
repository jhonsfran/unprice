import { describe, expect, it } from "vitest"
import { BudgetExceededError, BudgetRequestError, BudgetSettleError } from "./budgets"
import { Unprice } from "./client"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  })

const balance = {
  remaining: "49.95",
  held: "0.05",
  limits: [
    {
      id: "month",
      window: "month",
      enforce: "hard",
      amount: "50",
      consumed: "0",
      held: "0.05",
      remaining: "49.95",
      resetsAt: 1_793_491_200_000,
    },
  ],
  asOf: 1_792_000_000_000,
}

const authorized = {
  allowed: true,
  holdId: "h_7",
  amount: "0.05",
  expiresAt: 1_792_000_060_000,
  replayed: false,
  balance,
}

const settled = {
  holdId: "h_7",
  actual: "0.031",
  covered: "0.031",
  released: "0.019",
  overrun: "0",
  late: false,
  expired: false,
  crossed: [],
  replayed: false,
  balance: { ...balance, remaining: "49.969", held: "0" },
}

const released = {
  holdId: "h_7",
  released: "0.05",
  replayed: false,
  balance: { ...balance, remaining: "50", held: "0" },
}

const blocked = {
  limitId: "month",
  window: "month",
  remaining: "0.01",
  held: "0",
  resetsAt: 1_793_491_200_000,
  remedy: "wait_for_reset",
}

const exceeded = () =>
  json(
    {
      error: {
        code: "BUDGET_EXCEEDED",
        message: "Budget exceeded",
        docs: "https://docs.unprice.dev/api-reference/errors/code/BUDGET_EXCEEDED",
        requestId: "req_1",
        details: { kind: "budget_exceeded", blocked, balance },
      },
    },
    402
  )

const conflict = () =>
  json(
    {
      error: {
        code: "CONFLICT",
        message: "Hold h_7 is closed",
        docs: "https://docs.unprice.dev/api-reference/errors/code/CONFLICT",
        requestId: "req_2",
      },
    },
    409
  )

type Reply = Response | Error

const createClient = (replies: Reply[]) => {
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const client = new Unprice({
    token: "test-token",
    baseUrl: "https://example.com",
    disableTelemetry: true,
    retry: { attempts: 0 },
    fetch: async (request) => {
      const text = await request.text()
      requests.push({
        method: request.method,
        url: request.url,
        body: text ? JSON.parse(text) : null,
      })
      const reply = replies.shift()
      if (!reply) {
        throw new Error("No queued reply")
      }
      if (reply instanceof Error) {
        throw reply
      }
      return reply
    },
  })

  return { budget: client.budget("customer:acme"), requests }
}

describe("budget handle", () => {
  it("authorizes, then settles the hold by its id", async () => {
    const { budget, requests } = createClient([json(authorized), json(settled)])

    const authorization = await budget.authorize({ amount: 0.05, idempotencyKey: "msg_1" })

    expect(authorization.error).toBeUndefined()
    if (!authorization.result?.allowed) {
      throw new Error("expected an allowed authorization")
    }
    const { hold, ...rest } = authorization.result
    expect(rest).toEqual({ allowed: true, degraded: false, balance, replayed: false })
    expect({ id: hold.id, key: hold.key, amount: hold.amount, expiresAt: hold.expiresAt }).toEqual({
      id: "h_7",
      key: "customer:acme",
      amount: "0.05",
      expiresAt: 1_792_000_060_000,
    })

    const settlement = await hold.settle({ amount: "0.031" })

    expect(settlement).toEqual({ result: settled })
    expect(requests).toEqual([
      {
        method: "POST",
        url: "https://example.com/v1/budgets/authorize",
        body: { key: "customer:acme", amount: "0.05", idempotencyKey: "msg_1" },
      },
      {
        method: "POST",
        url: "https://example.com/v1/budgets/settle",
        body: { key: "customer:acme", holdId: "h_7", amount: "0.031" },
      },
    ])
  })

  it("returns a 402 as a denial with the blocking limit", async () => {
    const { budget } = createClient([exceeded()])

    const authorization = await budget.authorize({ amount: "1", idempotencyKey: "msg_2" })

    expect(authorization).toEqual({
      result: {
        allowed: false,
        degraded: false,
        blocked: { reason: "limit", ...blocked },
        balance,
      },
    })
  })

  it("denies as degraded when Unprice cannot be reached", async () => {
    const { budget } = createClient([new TypeError("fetch failed")])

    const authorization = await budget.authorize({ amount: "1", idempotencyKey: "msg_3" })

    expect(authorization).toEqual({
      result: {
        allowed: false,
        degraded: true,
        blocked: {
          reason: "unavailable",
          remedy: "retry",
          error: {
            code: "FETCH_ERROR",
            message: "fetch failed",
            docs: "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
            requestId: "N/A",
          },
        },
        balance: null,
      },
    })
  })

  it("returns other API errors as errors, not denials", async () => {
    const { budget } = createClient([conflict()])

    const authorization = await budget.authorize({ amount: "1", idempotencyKey: "msg_4" })

    expect(authorization.result).toBeUndefined()
    expect(authorization.error?.code).toBe("CONFLICT")
  })

  it("records with the occurredAt the caller passes", async () => {
    const recorded = { amount: "1", crossed: [], replayed: false, balance }
    const { budget, requests } = createClient([json(recorded)])

    await budget.record({ amount: 1, idempotencyKey: "evt_2", occurredAt: 1_796_000_000_000 })

    const [body] = requests.map((request) => request.body as Record<string, unknown>)
    expect(body).toEqual({
      key: "customer:acme",
      amount: "1",
      idempotencyKey: "evt_2",
      occurredAt: 1_796_000_000_000,
    })
  })

  it("sends number amounts as exact decimal strings and generates idempotency keys", async () => {
    const charged = { allowed: true, amount: "0.3", crossed: [], replayed: false, balance }
    const recorded = { amount: "1250", crossed: ["month"], replayed: false, balance }
    const { budget, requests } = createClient([
      json(authorized),
      json(charged),
      json(recorded),
      json(settled),
    ])

    const authorization = await budget.authorize({ amount: 0.1 + 0.2, ttlMs: 30_000 })
    const charge = await budget.charge({ amount: 0.000000014 })
    const record = await budget.record({ amount: 1250, idempotencyKey: "evt_1", occurredAt: 1 })
    if (!authorization.result?.allowed) {
      throw new Error("expected an allowed authorization")
    }
    await authorization.result.hold.settle({ amount: 2.5e-7 })

    expect(charge).toEqual({ result: { ...charged, degraded: false } })
    expect(record).toEqual({ result: recorded })
    const bodies = requests.map((request) => request.body as Record<string, unknown>)
    expect(bodies.map(({ amount }) => amount)).toEqual(["0.3", "0.00000001", "1250", "0.00000025"])
    expect(bodies[0]?.ttlMs).toBe(30_000)
    expect(bodies[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(bodies[1]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(bodies[0]?.idempotencyKey).not.toBe(bodies[1]?.idempotencyKey)
    expect(bodies[2]?.idempotencyKey).toBe("evt_1")
  })

  it("rejects non-finite number amounts before sending", async () => {
    const { budget, requests } = createClient([])

    await expect(budget.authorize({ amount: Number.NaN })).rejects.toThrow(
      "Budget amounts must be finite, received NaN"
    )
    expect(requests).toEqual([])
  })

  it("reads the budget by key", async () => {
    const { budget, requests } = createClient([json({ budget: { key: "customer:acme" } })])

    const read = await budget.get()

    expect(read).toEqual({ result: { budget: { key: "customer:acme" } } })
    expect(requests).toEqual([
      { method: "GET", url: "https://example.com/v1/budgets/get?key=customer%3Aacme", body: null },
    ])
  })
})

describe("budget.spend", () => {
  it("settles the actual the work returns and returns its value", async () => {
    const { budget, requests } = createClient([json(authorized), json(settled)])

    const value = await budget.spend({ estimate: 0.05 }, async (hold) => ({
      value: `answer under ${hold.id}`,
      actual: 0.031,
    }))

    expect(value).toBe("answer under h_7")
    expect(requests.map(({ url, body }) => [url, body])).toEqual([
      [
        "https://example.com/v1/budgets/authorize",
        {
          key: "customer:acme",
          amount: "0.05",
          idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      ],
      [
        "https://example.com/v1/budgets/settle",
        { key: "customer:acme", holdId: "h_7", amount: "0.031" },
      ],
    ])
  })

  it("releases the hold and rethrows when the work throws", async () => {
    const { budget, requests } = createClient([json(authorized), json(released)])

    await expect(
      budget.spend({ estimate: "0.05" }, async () => {
        throw new Error("model timed out")
      })
    ).rejects.toThrow("model timed out")
    expect(requests.map(({ url, body }) => [url, body])).toEqual([
      ["https://example.com/v1/budgets/authorize", expect.any(Object)],
      ["https://example.com/v1/budgets/release", { key: "customer:acme", holdId: "h_7" }],
    ])
  })

  it("throws BudgetExceededError without running the work when denied", async () => {
    const { budget } = createClient([exceeded()])
    let ran = false

    const error = await budget
      .spend({ estimate: "1" }, async () => {
        ran = true
        return { value: "unreachable", actual: "1" }
      })
      .catch((caught: unknown) => caught)

    expect(ran).toBe(false)
    expect(error).toBeInstanceOf(BudgetExceededError)
    expect(error).toMatchObject({
      message: "Budget exceeded: limit month (wait_for_reset)",
      blocked: { reason: "limit", ...blocked },
      balance,
    })
  })

  it("throws BudgetExceededError with an unavailable block when Unprice is unreachable", async () => {
    const { budget } = createClient([new TypeError("fetch failed")])

    const error = await budget
      .spend({ estimate: "1" }, async () => ({ value: "unreachable", actual: "1" }))
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(BudgetExceededError)
    expect(error).toMatchObject({
      message: "Budget unavailable: fetch failed",
      blocked: { reason: "unavailable", remedy: "retry" },
      balance: null,
    })
  })

  it("throws BudgetRequestError when the API rejects the authorization", async () => {
    const { budget } = createClient([conflict()])

    const error = await budget
      .spend({ estimate: "1" }, async () => ({ value: "unreachable", actual: "1" }))
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(BudgetRequestError)
    expect(error).toMatchObject({ error: { code: "CONFLICT", requestId: "req_2" } })
  })

  it("throws BudgetSettleError carrying the value and actual when the settle fails", async () => {
    const { budget, requests } = createClient([json(authorized), new TypeError("fetch failed")])

    const error = await budget
      .spend({ estimate: "0.05" }, async () => ({ value: "the answer", actual: 0.031 }))
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(BudgetSettleError)
    if (!(error instanceof BudgetSettleError)) {
      throw error
    }
    expect({
      message: error.message,
      value: error.value,
      actual: error.actual,
      holdId: error.hold.id,
      code: error.error.code,
    }).toEqual({
      message: "Settle failed for hold h_7: FETCH_ERROR fetch failed",
      value: "the answer",
      actual: 0.031,
      holdId: "h_7",
      code: "FETCH_ERROR",
    })
    expect(requests.map(({ url }) => url)).toEqual([
      "https://example.com/v1/budgets/authorize",
      "https://example.com/v1/budgets/settle",
    ])
  })
})
