import { describe, expect, it, vi } from "vitest"
import {
  BudgetExceededError,
  BudgetRecoveryError,
  BudgetRequestError,
  BudgetSettleError,
  BudgetUnavailableError,
} from "./budgets"
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
  released: "0.019",
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

const createClient = (replies: Reply[], retryAttempts = 0) => {
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const client = new Unprice({
    token: "test-token",
    baseUrl: "https://example.com",
    disableTelemetry: true,
    retry: { attempts: retryAttempts, backoff: () => 0 },
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

  it.each(["authorize", "charge"] as const)(
    "recovers a committed %s after a lost response with the caller's key",
    async (verb) => {
      const committedKeys = new Set<string>()
      const bodies: unknown[] = []
      const charged = { allowed: true, amount: "0.05", crossed: [], replayed: true, balance }
      const client = new Unprice({
        token: "test-token",
        baseUrl: "https://example.com",
        disableTelemetry: true,
        retry: { attempts: 0 },
        fetch: async (request) => {
          expect(request.url).toBe(`https://example.com/v1/budgets/${verb}`)
          const body = (await request.json()) as { idempotencyKey: string }
          bodies.push(body)
          if (!committedKeys.has(body.idempotencyKey)) {
            committedKeys.add(body.idempotencyKey)
            throw new TypeError("Response lost after commit")
          }
          return json(verb === "authorize" ? { ...authorized, replayed: true } : charged)
        },
      })
      const budget = client.budget("customer:acme")
      const input = { amount: "0.05", idempotencyKey: `msg_lost_${verb}` }

      const uncertain = await budget[verb](input)
      expect(uncertain).toEqual({
        result: {
          allowed: false,
          degraded: true,
          blocked: {
            reason: "unavailable",
            remedy: "retry",
            error: {
              code: "FETCH_ERROR",
              message: "Response lost after commit",
              docs: "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
              requestId: "N/A",
            },
          },
          balance: null,
        },
      })

      const recovered = await budget[verb](input)
      const hold = {
        id: authorized.holdId,
        key: "customer:acme",
        amount: authorized.amount,
        expiresAt: authorized.expiresAt,
        settle: expect.any(Function),
        release: expect.any(Function),
      }
      expect(recovered).toEqual({
        result:
          verb === "authorize"
            ? { allowed: true, degraded: false, hold, balance, replayed: true }
            : {
                allowed: true,
                degraded: false,
                amount: "0.05",
                crossed: [],
                replayed: true,
                balance,
              },
      })
      expect(committedKeys.size).toBe(1)
      expect(bodies).toEqual([
        { ...input, key: "customer:acme" },
        { ...input, key: "customer:acme" },
      ])
    }
  )

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

  it("sends number amounts as exact decimal strings and preserves caller keys", async () => {
    const charged = { allowed: true, amount: "0.00000001", crossed: [], replayed: false, balance }
    const recorded = { amount: "12.5", crossed: [], replayed: false, balance }
    const { budget, requests } = createClient([
      json({ ...authorized, amount: "0.3" }),
      json(charged),
      json(recorded),
      json({ ...settled, actual: "0.00000025", released: "0.29999975" }),
    ])

    const authorization = await budget.authorize({
      amount: 0.1 + 0.2,
      ttlMs: 30_000,
      idempotencyKey: "msg_decimal",
    })
    const charge = await budget.charge({ amount: 0.000000014, idempotencyKey: "charge_decimal" })
    const record = await budget.record({ amount: 12.5, idempotencyKey: "evt_1", occurredAt: 1 })
    if (!authorization.result?.allowed) {
      throw new Error("expected an allowed authorization")
    }
    await authorization.result.hold.settle({ amount: 2.5e-7 })

    expect(charge).toEqual({ result: { ...charged, degraded: false } })
    expect(record).toEqual({ result: recorded })
    const bodies = requests.map((request) => request.body as Record<string, unknown>)
    expect(bodies.map(({ amount }) => amount)).toEqual(["0.3", "0.00000001", "12.5", "0.00000025"])
    expect(bodies[0]?.ttlMs).toBe(30_000)
    expect(bodies[0]?.idempotencyKey).toBe("msg_decimal")
    expect(bodies[1]?.idempotencyKey).toBe("charge_decimal")
    expect(bodies[2]?.idempotencyKey).toBe("evt_1")
  })

  it("rejects non-finite number amounts before sending", async () => {
    const { budget, requests } = createClient([])

    await expect(
      budget.authorize({ amount: Number.NaN, idempotencyKey: "msg_invalid" })
    ).rejects.toThrow("Budget amounts must be finite, received NaN")
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

  it("retains uncertain usage and exposes the hold for partial settlement", async () => {
    const { budget, requests } = createClient([json(authorized), json(settled)])
    const cause = new Error("model timed out after producing tokens")

    const error = await budget
      .spend({ estimate: "0.05", idempotencyKey: "msg_timeout" }, async () => {
        throw cause
      })
      .catch((caught: unknown) => caught)

    if (!(error instanceof BudgetRecoveryError)) throw error
    expect(error).toMatchObject({
      name: "BudgetRecoveryError",
      reason: "work_failed",
      idempotencyKey: "msg_timeout",
      hold: { id: "h_7", key: "customer:acme" },
    })
    expect(error.cause).toBe(cause)
    expect(requests.map(({ url }) => url)).toEqual(["https://example.com/v1/budgets/authorize"])

    const recovery = await error.hold.settle({ amount: "0.031" })

    expect(recovery).toEqual({ result: settled })
    expect(requests.map(({ url, body }) => [url, body])).toEqual([
      [
        "https://example.com/v1/budgets/authorize",
        { key: "customer:acme", amount: "0.05", idempotencyKey: "msg_timeout" },
      ],
      [
        "https://example.com/v1/budgets/settle",
        { key: "customer:acme", holdId: "h_7", amount: "0.031" },
      ],
    ])
  })

  it("lets the caller release after confirming zero usage", async () => {
    const { budget, requests } = createClient([json(authorized), json(released)])
    const error = await budget
      .spend({ estimate: "0.05", idempotencyKey: "msg_canceled" }, async () => {
        throw new Error("provider rejected the request before starting")
      })
      .catch((caught: unknown) => caught)

    if (!(error instanceof BudgetRecoveryError)) throw error
    const recovery = await error.hold.release()

    expect(recovery).toEqual({ result: released })
    expect(requests.map(({ url }) => url)).toEqual([
      "https://example.com/v1/budgets/authorize",
      "https://example.com/v1/budgets/release",
    ])
  })

  it("does not repeat work when authorization replays", async () => {
    const { budget, requests } = createClient([json({ ...authorized, replayed: true })])
    let executions = 0

    const error = await budget
      .spend({ estimate: "0.05", idempotencyKey: "msg_replay" }, async () => {
        executions += 1
        return { value: "duplicate work", actual: "0.031" }
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(BudgetRecoveryError)
    expect(error).toMatchObject({
      reason: "authorization_replayed",
      idempotencyKey: "msg_replay",
      hold: { id: "h_7", key: "customer:acme", amount: "0.05" },
    })
    expect(executions).toBe(0)
    expect(requests).toEqual([
      {
        method: "POST",
        url: "https://example.com/v1/budgets/authorize",
        body: { key: "customer:acme", amount: "0.05", idempotencyKey: "msg_replay" },
      },
    ])
  })

  it("throws BudgetExceededError without running the work when denied", async () => {
    const { budget } = createClient([exceeded()])
    let ran = false

    const error = await budget
      .spend({ estimate: "1", idempotencyKey: "msg_denied" }, async () => {
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
      idempotencyKey: "msg_denied",
    })
  })

  it("exposes a generated key to recover an uncertain authorization", async () => {
    const { budget, requests } = createClient([
      new TypeError("fetch failed"),
      json({ ...authorized, replayed: true }),
    ])
    let executions = 0
    const work = async () => {
      executions += 1
      return { value: "unreachable", actual: "1" }
    }

    const error = await budget
      .spend({ estimate: "1", ttlMs: 30_000 }, work)
      .catch((caught: unknown) => caught)

    if (!(error instanceof BudgetUnavailableError)) throw error
    expect(error).toMatchObject({
      message: "Budget unavailable: fetch failed",
      error: { code: "FETCH_ERROR", message: "fetch failed" },
    })
    expect(error).not.toBeInstanceOf(BudgetExceededError)
    expect(error.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)

    const recovery = await budget
      .spend({ estimate: "1", ttlMs: 30_000, idempotencyKey: error.idempotencyKey }, work)
      .catch((caught: unknown) => caught)

    expect(recovery).toMatchObject({
      reason: "authorization_replayed",
      idempotencyKey: error.idempotencyKey,
      hold: { id: "h_7" },
    })
    expect(executions).toBe(0)
    expect(requests.map(({ body }) => body)).toEqual([
      {
        key: "customer:acme",
        amount: "1",
        ttlMs: 30_000,
        idempotencyKey: error.idempotencyKey,
      },
      {
        key: "customer:acme",
        amount: "1",
        ttlMs: 30_000,
        idempotencyKey: error.idempotencyKey,
      },
    ])
  })

  it("runs the work once when a transport retry replays its own generated key", async () => {
    const { budget, requests } = createClient(
      [
        new TypeError("response lost after commit"),
        json({ ...authorized, replayed: true }),
        json(settled),
      ],
      1
    )
    let executions = 0
    const value = await budget.spend({ estimate: "0.05" }, async () => {
      executions += 1
      return { value: "generated", actual: "0.031" }
    })

    expect([value, executions]).toEqual(["generated", 1])
    const [first, retry, settle] = requests.map(({ body }) => body)
    const generated = { key: "customer:acme", amount: "0.05", idempotencyKey: expect.any(String) }
    expect([first, retry]).toEqual([generated, generated])
    expect(retry).toEqual(first)
    expect(settle).toEqual({ key: "customer:acme", holdId: "h_7", amount: "0.031" })
  })

  it("throws BudgetRequestError when the API rejects the authorization", async () => {
    const { budget } = createClient([conflict()])

    const error = await budget
      .spend({ estimate: "1", idempotencyKey: "msg_conflict" }, async () => ({
        value: "unreachable",
        actual: "1",
      }))
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(BudgetRequestError)
    expect(error).toMatchObject({
      error: { code: "CONFLICT", requestId: "req_2" },
      idempotencyKey: "msg_conflict",
    })
  })

  it("throws BudgetSettleError carrying the value and actual when the settle fails", async () => {
    const { budget, requests } = createClient([
      json(authorized),
      new TypeError("fetch failed"),
      json({ ...settled, replayed: true }),
    ])
    let executions = 0

    const error = await budget
      .spend({ estimate: "0.05", idempotencyKey: "msg_settle" }, async () => {
        executions += 1
        return { value: "the answer", actual: 0.031 }
      })
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
      code: error.error?.code,
      idempotencyKey: error.idempotencyKey,
    }).toEqual({
      message: "Settle failed for hold h_7: FETCH_ERROR fetch failed",
      value: "the answer",
      actual: 0.031,
      holdId: "h_7",
      code: "FETCH_ERROR",
      idempotencyKey: "msg_settle",
    })
    const recovery = await error.hold.settle({ amount: error.actual })

    expect(recovery).toEqual({ result: { ...settled, replayed: true } })
    expect(executions).toBe(1)
    expect(requests.map(({ url }) => url)).toEqual([
      "https://example.com/v1/budgets/authorize",
      "https://example.com/v1/budgets/settle",
      "https://example.com/v1/budgets/settle",
    ])
    expect(requests.slice(1).map(({ body }) => body)).toEqual([
      { key: "customer:acme", holdId: "h_7", amount: "0.031" },
      { key: "customer:acme", holdId: "h_7", amount: "0.031" },
    ])
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "preserves recovery details when final usage %s cannot be serialized",
    async (actual) => {
      const { budget, requests } = createClient([json(authorized)])
      const value = { answer: "the work completed" }
      let executions = 0

      const error = await budget
        .spend({ estimate: "0.05", idempotencyKey: "msg_invalid_actual" }, async () => {
          executions += 1
          return { value, actual }
        })
        .catch((caught: unknown) => caught)

      if (!(error instanceof BudgetSettleError)) throw error
      expect(error.value).toBe(value)
      expect(error.actual).toBe(actual)
      expect(error.cause).toBeInstanceOf(RangeError)
      expect(error.error).toBeUndefined()
      expect(error.idempotencyKey).toBe("msg_invalid_actual")
      expect(error.hold).toMatchObject({ id: "h_7", key: "customer:acme", amount: "0.05" })
      expect(executions).toBe(1)
      expect(requests.map(({ url }) => url)).toEqual(["https://example.com/v1/budgets/authorize"])
    }
  )

  it("preserves recovery details when settlement rejects outside its API result", async () => {
    const { budget, requests } = createClient([json(authorized), json(settled)])
    const cause = new TypeError("settlement transport rejected")
    const value = { answer: "the work completed" }
    let executions = 0

    const error = await budget
      .spend({ estimate: "0.05", idempotencyKey: "msg_rejected_settle" }, async (hold) => {
        executions += 1
        vi.spyOn(hold, "settle").mockRejectedValueOnce(cause)
        return { value, actual: "0.031" }
      })
      .catch((caught: unknown) => caught)

    if (!(error instanceof BudgetSettleError)) throw error
    expect(error.value).toBe(value)
    expect(error.actual).toBe("0.031")
    expect(error.cause).toBe(cause)
    expect(error.error).toBeUndefined()
    expect(error.idempotencyKey).toBe("msg_rejected_settle")
    expect(error.hold).toMatchObject({ id: "h_7", key: "customer:acme", amount: "0.05" })
    expect(requests.map(({ url }) => url)).toEqual(["https://example.com/v1/budgets/authorize"])

    await expect(error.hold.settle({ amount: error.actual })).resolves.toEqual({ result: settled })
    expect(executions).toBe(1)
    expect(requests.map(({ url }) => url)).toEqual([
      "https://example.com/v1/budgets/authorize",
      "https://example.com/v1/budgets/settle",
    ])
  })

  it("preserves excess usage and the hold when the server rejects settlement", async () => {
    const rejection = {
      code: "CONFLICT",
      message: "Hold h_7 permits 0.05, not 0.06",
      docs: "https://docs.unprice.dev/api-reference/errors/code/CONFLICT",
      requestId: "req_excess",
    }
    const { budget, requests } = createClient([
      json(authorized),
      json({ error: rejection }, 409),
      json({ error: rejection }, 409),
    ])
    let executions = 0

    const error = await budget
      .spend({ estimate: "0.05", idempotencyKey: "msg_excess" }, async () => {
        executions += 1
        return { value: "provider exceeded its configured maximum", actual: "0.06" }
      })
      .catch((caught: unknown) => caught)

    if (!(error instanceof BudgetSettleError)) throw error
    expect(error).toMatchObject({
      name: "BudgetSettleError",
      value: "provider exceeded its configured maximum",
      actual: "0.06",
      idempotencyKey: "msg_excess",
      hold: { id: "h_7", key: "customer:acme", amount: "0.05" },
      error: rejection,
    })
    expect(executions).toBe(1)
    expect(requests).toEqual([
      {
        method: "POST",
        url: "https://example.com/v1/budgets/authorize",
        body: { key: "customer:acme", amount: "0.05", idempotencyKey: "msg_excess" },
      },
      {
        method: "POST",
        url: "https://example.com/v1/budgets/settle",
        body: { key: "customer:acme", holdId: "h_7", amount: "0.06" },
      },
    ])

    const retried = await error.hold.settle({ amount: error.actual })

    expect(retried).toEqual({ error: rejection })
    expect(requests[2]).toEqual({
      method: "POST",
      url: "https://example.com/v1/budgets/settle",
      body: { key: "customer:acme", holdId: "h_7", amount: "0.06" },
    })
  })
})
