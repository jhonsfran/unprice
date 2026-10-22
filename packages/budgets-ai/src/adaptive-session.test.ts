import { BudgetRequestError, BudgetUnavailableError, Unprice } from "@unprice/budgets"
import { describe, expect, it, vi } from "vitest"
import { type BudgetProtocol, type TokenPricing, createBudgetSession } from "./index"

const baseRates = { input: 1, output: 2, cacheRead: 0, cacheWrite: 1 }

function harness(options: {
  capacities: string[]
  rates?: TokenPricing
  count?: unknown
  countFailure?: boolean
  countWait?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  authorizationWait?: boolean
  authorizationFailure?: "transport" | "rejected"
  spendable?: string
  protocol?: BudgetProtocol
}) {
  const holds: Array<{ amount: string; idempotencyKey: string }> = []
  const counts: Request[] = []
  const generated: Request[] = []
  const settled: Array<{ holdId: string; amount: string }> = []
  const budget = new Unprice({
    token: "test",
    retry: { attempts: 0 },
    disableTelemetry: true,
    fetch: async (request) => {
      const body = await request.json()
      if (request.url.endsWith("/authorize")) {
        holds.push(body)
        if (options.authorizationWait) return new Promise<Response>(() => {})
        if (options.authorizationFailure === "transport") throw new Error("lost response")
        if (options.authorizationFailure === "rejected")
          return Response.json(
            {
              error: {
                code: "CONFLICT",
                message: "rejected",
                docs: "",
                requestId: "test",
              },
            },
            { status: 409 }
          )
        const remaining =
          options.capacities[Math.min(holds.length - 1, options.capacities.length - 1)] ?? "0"
        const balance = { remaining, held: "0", limits: [] }
        if (Number(body.amount) > Number(remaining))
          return Response.json(
            {
              error: {
                code: "BUDGET_EXCEEDED",
                message: "limit",
                docs: "",
                requestId: "test",
                details: {
                  kind: "budget_exceeded",
                  balance,
                  blocked: {
                    limitId: "day",
                    window: "day",
                    remaining,
                    held: "0",
                    resetsAt: 1,
                    remedy: "wait_for_reset",
                  },
                },
              },
            },
            { status: 409 }
          )
        return Response.json({
          holdId: `h_${holds.length}`,
          amount: body.amount,
          expiresAt: Date.now() + 300_000,
          replayed: false,
          created: false,
          balance,
        })
      }
      settled.push(body)
      return Response.json({
        holdId: body.holdId,
        actual: body.amount,
        released: "0",
        expired: false,
        crossed: [],
        replayed: false,
        balance: { remaining: "0.001", held: "0", limits: [] },
      })
    },
  }).budget("customer")
  if (options.spendable !== undefined)
    Object.defineProperty(budget, "spendableAmount", { get: () => options.spendable })
  const session = createBudgetSession({
    getBudget: () => budget,
    model: {
      id: "model",
      pricing: options.rates ?? baseRates,
      limits: { context: 1_000_000, output: 4096 },
    },
    maxOutputTokens: 4096,
    mode: "generate",
    ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { budgetTimeoutMs: options.timeoutMs }),
    fetch: async (input, init) => {
      const request = new Request(input, init)
      if (request.url.includes("/input_tokens")) {
        counts.push(request.clone())
        if (options.countWait)
          return new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            })
          })
        if (options.countFailure) throw new Error("count unavailable")
        return Response.json(options.count ?? {})
      }
      generated.push(request.clone())
      return Response.json({})
    },
  })
  const dispatch = (
    body: object = { model: "model", input: "Hello", max_output_tokens: 32 },
    url = "https://provider.test/proxy/v1/responses?project=a"
  ) =>
    session.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: "Bearer provider-secret",
      },
      body: JSON.stringify(body),
    })
  return { session, dispatch, holds, counts, generated, settled }
}

describe("adaptive admission", () => {
  it("bounds full-prompt parsing while finding an affordable output allowance", async () => {
    const input = "x".repeat(128_000)
    const h = harness({
      capacities: ["0.0011"],
      rates: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      count: { object: "response.input_tokens", input_tokens: 1000 },
    })
    const parse = JSON.parse
    let parsedBytes = 0
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      parsedBytes += text.length
      return parse(text, reviver)
    })
    try {
      await h.dispatch({ model: "model", input, max_output_tokens: 4096 })
    } finally {
      spy.mockRestore()
    }
    expect(h.session.reserved).toMatchObject({ outputTokens: 100, inputSource: "provider-count" })
    expect(parsedBytes).toBeLessThan(4 * input.length)
    expect(await h.generated[0]?.json()).toMatchObject({ input, max_output_tokens: 100 })
  })

  it("does not count a funded request and retains the caller's smaller ceiling", async () => {
    const h = harness({ capacities: ["1"] })
    await h.dispatch()
    expect(h.holds.map((hold) => hold.amount)).toEqual(["0.000243"])
    expect(h.counts).toHaveLength(0)
    expect(await h.generated[0]?.json()).toMatchObject({ max_output_tokens: 32 })
    expect(h.session.reserved).toMatchObject({
      requestedOutputTokens: 32,
      outputTokens: 32,
      inputSource: "byte-bound",
    })
  })

  it("counts once after denial and admits the original allowance with a fresh intent", async () => {
    const h = harness({
      capacities: ["0.0011"],
      rates: { ...baseRates, input: 10, output: 1 },
      count: { object: "response.input_tokens", input_tokens: 100 },
    })
    await h.dispatch()
    expect(h.holds.map((hold) => hold.amount)).toEqual(["0.001822", "0.001032"])
    expect(new Set(h.holds.map((hold) => hold.idempotencyKey)).size).toBe(2)
    expect(h.counts).toHaveLength(1)
    expect(h.generated).toHaveLength(1)
    expect(h.session.reserved).toMatchObject({
      inputTokens: 100,
      inputSource: "provider-count",
      outputTokens: 32,
    })
    await h.session.settle()
    expect(h.settled).toEqual([{ key: "customer", holdId: "h_2", amount: "0.001032" }])
  })

  it("preserves endpoint, authentication, and all input-affecting count fields", async () => {
    const h = harness({
      capacities: ["0.000001"],
      rates: { input: 10, output: 0.01, cacheRead: 0, cacheWrite: 0 },
      count: { object: "response.input_tokens", input_tokens: 0 },
    })
    const fields = {
      model: "model",
      input: "Hello",
      instructions: "Be brief",
      parallel_tool_calls: false,
      personality: "default",
      reasoning: { effort: "low" },
      text: { format: { type: "text" } },
      tool_choice: "auto",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      truncation: "disabled",
    }
    await h.dispatch({
      ...fields,
      max_output_tokens: 32,
      temperature: 0.1,
      metadata: { task: "test" },
      store: false,
    })
    expect(h.counts[0]?.url).toBe("https://provider.test/proxy/v1/responses/input_tokens?project=a")
    expect(h.counts[0]?.headers.get("authorization")).toBe("Bearer provider-secret")
    expect(h.counts[0]?.headers.get("accept")).toBe("application/json")
    expect(await h.counts[0]?.json()).toEqual(fields)
    expect(h.generated).toHaveLength(1)
    expect(await h.generated[0]?.json()).toMatchObject({
      ...fields,
      max_output_tokens: 32,
      stream: false,
    })
  })

  it.each([
    {},
    { object: "response", input_tokens: 1 },
    { object: "response.input_tokens", input_tokens: -1 },
    { object: "response.input_tokens", input_tokens: 0.5 },
    { object: "response.input_tokens", input_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ])(
    "retains the byte bound after malformed count %j and sends the largest affordable cap",
    async (count) => {
      const h = harness({ capacities: ["0.00022"], count })
      await h.dispatch()
      expect(h.holds.map((hold) => hold.amount)).toEqual(["0.000243", "0.000219"])
      expect(await h.generated[0]?.json()).toMatchObject({ input: "Hello", max_output_tokens: 20 })
      expect(h.session.reserved).toMatchObject({
        inputSource: "byte-bound",
        requestedOutputTokens: 32,
        outputTokens: 20,
      })
    }
  )

  it("falls back on a failed count without dispatching twice", async () => {
    const h = harness({ capacities: ["0.00022"], countFailure: true })
    await h.dispatch()
    expect(h.counts).toHaveLength(1)
    expect(h.generated).toHaveLength(1)
    expect(h.holds.map((hold) => hold.amount)).toEqual(["0.000243", "0.000219"])
  })

  it("uses reliable counts even when they exceed the byte bound", async () => {
    const h = harness({
      capacities: ["0.00022"],
      count: { object: "response.input_tokens", input_tokens: 1000 },
    })
    await expect(h.dispatch()).rejects.toThrow("Budget exceeded")
    expect(h.holds).toHaveLength(1)
    expect(h.counts).toHaveLength(1)
    expect(h.generated).toHaveLength(0)
  })

  it("resizes once more after contention and settles only the final hold", async () => {
    const h = harness({
      capacities: ["0.001", "0.0005"],
      rates: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0 },
    })
    await h.dispatch({ model: "model", input: "Hello", max_output_tokens: 4096 })
    expect(h.holds.map((hold) => hold.amount)).toEqual(["0.008192", "0.001", "0.0005"])
    expect(new Set(h.holds.map((hold) => hold.idempotencyKey)).size).toBe(3)
    expect(await h.generated[0]?.json()).toMatchObject({ max_output_tokens: 250 })
    expect(h.counts).toHaveLength(1)
    expect(h.generated).toHaveLength(1)
    await h.session.settle(0.0001)
    expect(h.settled).toEqual([{ key: "customer", holdId: "h_3", amount: "0.0001" }])
  })

  it("stops after three definite denials", async () => {
    const h = harness({
      capacities: ["0.001", "0.0005", "0.0002"],
      rates: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0 },
    })
    await expect(
      h.dispatch({ model: "model", input: "Hello", max_output_tokens: 4096 })
    ).rejects.toThrow("Budget exceeded")
    expect(h.holds).toHaveLength(3)
    expect(h.counts).toHaveLength(1)
    expect(h.generated).toHaveLength(0)
  })

  it.each(["transport", "rejected"] as const)(
    "does not adapt after %s authorization failure",
    async (authorizationFailure) => {
      const h = harness({ capacities: ["1"], authorizationFailure })
      await expect(h.dispatch()).rejects.toBeInstanceOf(
        authorizationFailure === "transport" ? BudgetUnavailableError : BudgetRequestError
      )
      expect(h.holds).toHaveLength(1)
      expect(h.counts).toHaveLength(0)
      expect(h.generated).toHaveLength(0)
    }
  )

  it("stops admission when the caller cancels the count", async () => {
    const controller = new AbortController()
    const h = harness({ capacities: ["0.00022"], signal: controller.signal, countWait: true })
    const result = h.dispatch()
    await vi.waitFor(() => expect(h.counts).toHaveLength(1))
    controller.abort(new DOMException("Cancelled", "AbortError"))
    await expect(result).rejects.toThrow("Cancelled")
    expect(h.holds).toHaveLength(1)
    expect(h.generated).toHaveLength(0)
  })

  it("does not start another intent when authorization reaches the admission deadline", async () => {
    const h = harness({ capacities: ["0.00022"], timeoutMs: 30, authorizationWait: true })
    await expect(h.dispatch()).rejects.toThrow("timed out")
    expect(h.holds).toHaveLength(1)
    expect(h.generated).toHaveLength(0)
  })

  it("falls back after a short count deadline while admission time remains", async () => {
    const h = harness({ capacities: ["0.00022"], timeoutMs: 200, countWait: true })
    await h.dispatch()
    expect(h.counts).toHaveLength(1)
    expect(h.holds.map((hold) => hold.amount)).toEqual(["0.000243", "0.000219"])
    expect(h.generated).toHaveLength(1)
  })

  it("includes the changed byte length when finding the largest affordable cap", async () => {
    const h = harness({
      capacities: ["0.000179"],
      rates: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      countFailure: true,
    })
    await h.dispatch({ model: "model", input: "Hello", max_output_tokens: 100 })
    expect(h.holds.map((hold) => hold.amount)).toEqual(["0.00018", "0.000179"])
    expect(await h.generated[0]?.json()).toMatchObject({ max_output_tokens: 99 })
  })

  it("keeps Anthropic enabled thinking valid when shrinking output", async () => {
    const h = harness({
      protocol: "anthropic-messages",
      capacities: ["0.0011"],
      rates: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
    })
    await h.dispatch(
      {
        model: "model",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 4096,
        thinking: { type: "enabled", budget_tokens: 2048 },
      },
      "https://provider.test/v1/messages"
    )
    expect(h.holds.map((hold) => hold.amount)).toEqual(["0.004096", "0.0011"])
    expect(await h.generated[0]?.json()).toMatchObject({
      max_tokens: 1100,
      thinking: { type: "enabled", budget_tokens: 1099 },
      stream: false,
    })
    expect(h.counts).toHaveLength(0)
  })

  it("rejects Anthropic below the enabled thinking minimum", async () => {
    const h = harness({
      protocol: "anthropic-messages",
      capacities: ["0.001024"],
      rates: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
    })
    await expect(
      h.dispatch(
        {
          model: "model",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 4096,
          thinking: { type: "enabled", budget_tokens: 2048 },
        },
        "https://provider.test/v1/messages"
      )
    ).rejects.toThrow("Budget exceeded")
    expect(h.holds).toHaveLength(1)
    expect(h.generated).toHaveLength(0)
  })

  it("preserves Gemini thinking settings while capping combined output", async () => {
    const h = harness({
      protocol: "google-generative-ai",
      capacities: ["0.0001"],
      rates: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
    })
    await h.dispatch(
      {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: {
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
        },
      },
      "https://provider.test/v1beta/models/model:generateContent"
    )
    expect(h.holds.map((hold) => hold.amount)).toEqual(["0.004096", "0.0001"])
    expect(await h.generated[0]?.json()).toMatchObject({
      generationConfig: {
        maxOutputTokens: 100,
        thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
      },
    })
    expect(h.counts).toHaveLength(0)
  })

  it("uses immediate local capacity instead of the global balance and never calls it exhausted", async () => {
    const h = harness({ capacities: ["0", "0.00022"], spendable: "0.00022" })
    await h.dispatch()
    expect(h.holds.map((hold) => hold.amount)).toEqual(["0.000243", "0.000219"])
    expect(h.session.exhausted("0")).toBe(false)
  })

  it("counts a zero-output-rate request and retains the full ceiling", async () => {
    const h = harness({
      capacities: ["0.0001"],
      rates: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      count: { object: "response.input_tokens", input_tokens: 50 },
    })
    await h.dispatch()
    expect(h.holds.map((hold) => hold.amount)).toEqual(["0.000179", "0.00005"])
    expect(await h.generated[0]?.json()).toMatchObject({ max_output_tokens: 32 })
    expect(h.session.exhausted("0")).toBe(false)
  })
})
