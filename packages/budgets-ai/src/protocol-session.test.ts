import { Unprice } from "@unprice/budgets"
import { describe, expect, it } from "vitest"
import { type BudgetProtocol, createBudgetSession } from "./index"

const pricing = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }
const limits = { maxInputTokens: 1000, maxOutputTokens: 256 }
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
    modelLimits,
    getBudget: () => client.budget("customer"),
    modelId: "model",
    pricing,
    maxOutputTokens: 4096,
    mode: "generate",
    fetch: async (input, init) => {
      order.push("generate")
      bodies.push(await new Request(input, init).json())
      return Response.json({})
    },
  })
  modelLimits.maxInputTokens = 1
  modelLimits.maxOutputTokens = 32
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
    it("reserves trusted input and final output limits before one paid request", async () => {
      const test = fixture(provider.protocol)
      await dispatch(test.session)
      await test.session.settle(0.00002)
      expect(test.order).toEqual(["authorize", "generate", "settle"])
      expect(test.amounts).toEqual([0.001762, 0.00002])
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
      expect(test.amounts).toEqual([0.001762, 0.001762])
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

describe("trusted limits", () => {
  it.each([0, 0.5, Number.POSITIVE_INFINITY])(
    "rejects invalid input bound %s",
    (maxInputTokens) => {
      expect(() =>
        createBudgetSession({
          protocol: "anthropic-messages",
          modelLimits: { ...limits, maxInputTokens },
          modelId: "model",
          pricing,
          maxOutputTokens: 256,
          mode: "generate",
          getBudget: () => {
            throw new Error("unused")
          },
        })
      ).toThrow("trusted model limits")
    }
  )
  it("validates the caller output cap before clamping to the model limit", () => {
    expect(() =>
      createBudgetSession({
        protocol: "google-generative-ai",
        modelLimits: limits,
        modelId: "model",
        pricing,
        maxOutputTokens: 4096.5,
        mode: "generate",
        getBudget: () => {
          throw new Error("unused")
        },
      })
    ).toThrow("maxOutputTokens")
  })
})
