import { Unprice } from "@unprice/budgets"
import { describe, expect, it } from "vitest"
import { type BudgetProtocol, TOOL_PROMPT_TOKENS, createBudgetSession } from "./index"
import { inputBound } from "./input-bound"

const pricing = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }
const limits = { context: 1000, output: 256 }
const providers = [
  {
    protocol: "anthropic-messages",
    url: "https://provider.test/v1/messages",
    body: { model: "model", messages: [{ role: "user", content: "Hello" }], max_tokens: 1024 },
  },
  {
    protocol: "google-generative-ai",
    url: "https://provider.test/v1beta/models/model:generateContent",
    body: {
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      generationConfig: { maxOutputTokens: 1024 },
    },
  },
] as const

/**
 * The hold the cap requires for the body the provider received: its byte bound at the highest
 * input rate (cacheWrite, 1.25) plus the 256-token output limit at 2, rounded up at eight
 * decimals. Stated here on its own so the test does not borrow the adapter's arithmetic.
 */
function hold(body: unknown, messages: number, hiddenTokens = 0): number {
  const bound = inputBound(JSON.stringify(body), messages) + hiddenTokens
  return Math.ceil(((bound * 1.25 + 256 * 2) / 1_000_000) * 100_000_000) / 100_000_000
}

function fixture(protocol: Exclude<BudgetProtocol, "openai-responses">, denied = false) {
  const order: string[] = []
  const amounts: number[] = []
  const bodies: unknown[] = []
  const client = new Unprice({
    token: "test",
    retry: { attempts: 0 },
    fetch: async (request) => {
      const body = (await request.json()) as { amount: string }
      amounts.push(Number(body.amount))
      if (request.url.endsWith("/authorize")) {
        order.push("authorize")
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
          expiresAt: Date.now() + 300000,
          replayed: false,
          balance: { remaining: "1", held: body.amount, limits: [] },
        })
      }
      order.push("settle")
      return Response.json({})
    },
  })
  const modelLimits = { ...limits }
  const session = createBudgetSession({
    protocol,
    getBudget: () => client.budget("customer"),
    model: { id: "model", pricing, limits: modelLimits },
    maxOutputTokens: 4096,
    mode: "generate",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      order.push(request.url.includes("count") ? "count" : "generate")
      bodies.push(await request.json())
      return Response.json({})
    },
  })
  modelLimits.context = 1
  modelLimits.output = 32
  return { session, order, amounts, bodies }
}

for (const provider of providers)
  describe(provider.protocol, () => {
    const dispatch = (
      session: ReturnType<typeof createBudgetSession>,
      url: string = provider.url
    ) =>
      session.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(provider.body),
      })
    it("reserves the byte bound and the final output limit before one paid request, with no count", async () => {
      const test = fixture(provider.protocol)
      await dispatch(test.session)
      await test.session.settle(0.00002)
      expect(test.order).toEqual(["authorize", "generate", "settle"])
      expect(test.amounts).toEqual([hold(test.bodies[0], 1), 0.00002])
      expect(test.bodies[0]).toMatchObject(
        provider.protocol === "anthropic-messages"
          ? { max_tokens: 256, service_tier: "standard_only", stream: false }
          : {
              generationConfig: {
                maxOutputTokens: 256,
                candidateCount: 1,
                responseModalities: ["TEXT"],
              },
              serviceTier: "standard",
            }
      )
    })
    it("charges the full bound when final usage is unknown", async () => {
      const test = fixture(provider.protocol)
      await dispatch(test.session)
      await test.session.settle()
      const reserved = hold(test.bodies[0], 1)
      expect(test.amounts).toEqual([reserved, reserved])
    })
    it("blocks a denied reservation without a provider request", async () => {
      const test = fixture(provider.protocol, true)
      await expect(dispatch(test.session)).rejects.toThrow("Budget exceeded")
      expect(test.order).toEqual(["authorize"])
    })
    it("rejects a different provider route before authorization", async () => {
      const test = fixture(provider.protocol)
      await expect(dispatch(test.session, "https://provider.test/v1/other")).rejects.toThrow(
        "route"
      )
      expect(test.order).toEqual([])
    })
  })

describe("hidden tool prompt", () => {
  it("reserves Anthropic's tool-use system prompt when the request carries tools", async () => {
    const test = fixture("anthropic-messages")
    const body = {
      model: "model",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
    }
    await test.session.fetch("https://provider.test/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(TOOL_PROMPT_TOKENS["anthropic-messages"]).toBe(1024)
    expect(TOOL_PROMPT_TOKENS["openai-responses"]).toBe(0)
    expect(TOOL_PROMPT_TOKENS["google-generative-ai"]).toBe(0)
    expect(test.amounts).toEqual([hold(test.bodies[0], 1, 1024)])
  })

  it("reserves nothing extra for an Anthropic request without tools", async () => {
    const test = fixture("anthropic-messages")
    await test.session.fetch("https://provider.test/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(providers[0].body),
    })
    expect(test.amounts).toEqual([hold(test.bodies[0], 1)])
  })
})

describe("model limits", () => {
  it.each([0, 0.5, Number.POSITIVE_INFINITY])("rejects context limit %s", (context) => {
    expect(() =>
      createBudgetSession({
        protocol: "anthropic-messages",
        model: { id: "model", pricing, limits: { ...limits, context } },
        maxOutputTokens: 256,
        mode: "generate",
        getBudget: () => {
          throw new Error("unused")
        },
      })
    ).toThrow("model limits")
  })
  it("validates the caller output cap before clamping to the model limit", () => {
    expect(() =>
      createBudgetSession({
        protocol: "google-generative-ai",
        model: { id: "model", pricing, limits },
        maxOutputTokens: 4096.5,
        mode: "generate",
        getBudget: () => {
          throw new Error("unused")
        },
      })
    ).toThrow("maxOutputTokens")
  })
})
