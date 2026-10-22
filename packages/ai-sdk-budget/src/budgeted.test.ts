import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogle } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { Unprice } from "@unprice/budgets"
import { inputBound } from "@unprice/budgets-ai"
import { generateText, jsonSchema, stepCountIs, tool } from "ai"
import { describe, expect, it } from "vitest"
import { budgeted, createUnpriceBudgetMiddleware } from "./index"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const rates = { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 1 }
const limits = { context: 1_000_000, output: 4096 }
const catalog = ["openai/gpt-test", "anthropic/claude-test", "google/gemini-test"].map((id) => {
  const [provider, model] = id.split("/")
  return { id, provider, model, unit: "money:USD", per: 1_000_000, rates, tiers: [], limits }
})
const balance = { remaining: "1", held: "0", limits: [], asOf: 1_792_000_000_000 }

/** The hold the cap requires for the request the provider received, restated here on its own. */
function expectedHold(body: string, messages: number, outputTokens: number): string {
  const bound = inputBound(body, messages)
  const cost = (bound * 1 + outputTokens * 4) / 1_000_000
  return (Math.ceil(cost * 100_000_000) / 100_000_000).toFixed(8).replace(/\.?0+$/, "")
}

function openaiMessages(body: string): number {
  const request = JSON.parse(body) as { input: unknown; instructions?: string }
  const items = typeof request.input === "string" ? 1 : (request.input as unknown[]).length
  return items + (request.instructions === undefined ? 0 : 1)
}

const openaiCall = (name: string, index: number) => ({
  type: "function_call",
  id: `fc_${index}`,
  call_id: `call_${index}`,
  name,
  arguments: JSON.stringify({ q: `query ${index}` }),
  status: "completed",
})

const openaiResponse = (output: unknown[], index: number) => ({
  id: `resp_${index}`,
  object: "response",
  created_at: 1_792_000_000,
  model: "gpt-test",
  status: "completed",
  output,
  usage: {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: 14,
  },
})

const openaiText = (index: number) =>
  openaiResponse(
    [
      {
        type: "message",
        id: `msg_${index}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "answer", annotations: [] }],
      },
    ],
    index
  )

function harness(options: { toolSteps?: number; unknownModel?: boolean } = {}) {
  const authorized: Array<{
    key: string
    amount: string
    idempotencyKey: string
    ifMissing?: unknown
  }> = []
  const settled: Array<{ holdId: string; amount: string }> = []
  const catalogRequests: string[] = []
  const providerRequests: Array<{ url: string; headers: Headers; body: string }> = []
  const unprice = new Unprice({
    token: "test",
    baseUrl: "https://budgets.test",
    disableTelemetry: true,
    retry: { attempts: 0 },
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/v1/budgets/models") {
        const ids = url.searchParams.get("ids") ?? ""
        catalogRequests.push(ids)
        return json({
          version: "2026-10-20",
          models: options.unknownModel ? [] : catalog.filter((row) => ids.includes(row.id)),
        })
      }
      const body = (await request.json()) as Record<string, unknown>
      if (url.pathname === "/v1/budgets/authorize") {
        authorized.push({
          key: String(body.key ?? ""),
          amount: String(body.amount ?? ""),
          idempotencyKey: String(body.idempotencyKey ?? ""),
          ifMissing: body.ifMissing,
        })
        return json({
          allowed: true,
          holdId: `h_${authorized.length}`,
          amount: body.amount,
          expiresAt: Date.now() + 300_000,
          replayed: false,
          balance,
        })
      }
      if (url.pathname === "/v1/budgets/settle") {
        settled.push({ holdId: String(body.holdId ?? ""), amount: String(body.amount ?? "") })
        return json({
          holdId: body.holdId,
          actual: body.amount,
          released: "0",
          expired: false,
          crossed: [],
          replayed: false,
          balance,
        })
      }
      throw new Error(`Unexpected Unprice request ${url.pathname}`)
    },
  })
  let generation = 0
  const providerFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    providerRequests.push({
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    })
    generation++
    if (request.url.includes("api.openai.com")) {
      return json(
        generation <= (options.toolSteps ?? 0)
          ? openaiResponse([openaiCall("lookup", generation)], generation)
          : openaiText(generation)
      )
    }
    if (request.url.includes("api.anthropic.com")) {
      return json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "answer" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 8,
          output_tokens: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      })
    }
    return json({
      responseId: "google_1",
      candidates: [
        { content: { role: "model", parts: [{ text: "answer" }] }, finishReason: "STOP" },
      ],
      usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 3, totalTokenCount: 16 },
    })
  }
  return { unprice, authorized, settled, catalogRequests, providerRequests, providerFetch }
}

describe("budgeted provider", () => {
  it("runs a three-step tool loop with one hold per step under the key named per call", async () => {
    const h = harness({ toolSteps: 2 })
    const openai = budgeted(
      createOpenAI,
      { unprice: h.unprice, budget: "customer:a", maxOutputTokens: 16 },
      { apiKey: "test", fetch: h.providerFetch }
    )
    const lookup = tool({
      inputSchema: jsonSchema<{ q: string }>({
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      }),
      execute: async ({ q }) => `found ${q}`,
    })
    const result = await generateText({
      model: openai("gpt-test"),
      system: "Be terse.",
      prompt: "hello",
      tools: { lookup },
      stopWhen: stepCountIs(5),
      maxOutputTokens: 16,
      maxRetries: 0,
      providerOptions: { unprice: { budget: "run:r_1" } },
    })

    expect(result.text).toBe("answer")
    expect(result.steps).toHaveLength(3)
    expect(h.providerRequests).toHaveLength(3)
    expect(h.authorized.map((hold) => hold.key)).toEqual(["run:r_1", "run:r_1", "run:r_1"])
    expect(h.authorized.map((hold) => hold.amount)).toEqual(
      h.providerRequests.map((request) =>
        expectedHold(request.body, openaiMessages(request.body), 16)
      )
    )
    expect(new Set(h.authorized.map((hold) => hold.idempotencyKey)).size).toBe(3)
    expect(h.settled).toEqual([
      { holdId: "h_1", amount: "0.000025" },
      { holdId: "h_2", amount: "0.000025" },
      { holdId: "h_3", amount: "0.000025" },
    ])
    expect(h.catalogRequests).toEqual(["openai/gpt-test"])
    for (const request of h.providerRequests) {
      expect(request.url).toBe("https://api.openai.com/v1/responses")
      expect(request.headers.get("x-unprice-budget-call")).toBeNull()
      expect(request.body).not.toContain("unprice")
      expect(JSON.parse(request.body)).toMatchObject({ max_output_tokens: 16, model: "gpt-test" })
    }
  })

  it("falls back to the wrapper's budget when a call names none", async () => {
    const h = harness()
    const openai = budgeted(
      createOpenAI,
      { unprice: h.unprice, budget: "customer:a", maxOutputTokens: 16 },
      { apiKey: "test", fetch: h.providerFetch }
    )
    await generateText({ model: openai("gpt-test"), prompt: "hello", maxRetries: 0 })
    expect(h.authorized.map((hold) => hold.key)).toEqual(["customer:a"])
  })

  it("refuses a call that names no budget at all", async () => {
    const h = harness()
    const openai = budgeted(
      createOpenAI,
      { unprice: h.unprice, maxOutputTokens: 16 },
      { apiKey: "test", fetch: h.providerFetch }
    )
    await expect(
      generateText({ model: openai("gpt-test"), prompt: "hello", maxRetries: 0 })
    ).rejects.toThrow("budget")
    expect(h.authorized).toEqual([])
    expect(h.providerRequests).toEqual([])
  })

  it("refuses a model the catalog does not know before any hold or provider call", async () => {
    const h = harness({ unknownModel: true })
    const openai = budgeted(
      createOpenAI,
      { unprice: h.unprice, budget: "customer:a", maxOutputTokens: 16 },
      { apiKey: "test", fetch: h.providerFetch }
    )
    await expect(
      generateText({ model: openai("gpt-test"), prompt: "hello", maxRetries: 0 })
    ).rejects.toThrow("openai/gpt-test")
    expect(h.authorized).toEqual([])
    expect(h.providerRequests).toEqual([])
  })

  it("prices a model from the models option without asking the catalog", async () => {
    const h = harness({ unknownModel: true })
    const openai = budgeted(
      createOpenAI,
      {
        unprice: h.unprice,
        budget: "customer:a",
        maxOutputTokens: 16,
        models: { "openai/gpt-test": { rates, tiers: [], limits } },
      },
      { apiKey: "test", fetch: h.providerFetch }
    )
    const result = await generateText({ model: openai("gpt-test"), prompt: "hello", maxRetries: 0 })
    expect(result.text).toBe("answer")
    expect(h.catalogRequests).toEqual([])
    expect(h.authorized).toHaveLength(1)
  })

  it("takes the protocol from the model for Anthropic and Google", async () => {
    const h = harness()
    const anthropic = budgeted(
      createAnthropic,
      { unprice: h.unprice, budget: "customer:a", maxOutputTokens: 16 },
      { apiKey: "test", fetch: h.providerFetch }
    )
    const google = budgeted(
      createGoogle,
      { unprice: h.unprice, budget: "customer:a", maxOutputTokens: 16 },
      { apiKey: "test", fetch: h.providerFetch }
    )
    const claude = await generateText({
      model: anthropic("claude-test"),
      prompt: "hello",
      maxRetries: 0,
    })
    const gemini = await generateText({
      model: google("gemini-test"),
      prompt: "hello",
      maxRetries: 0,
    })
    expect([claude.text, gemini.text]).toEqual(["answer", "answer"])
    expect(h.catalogRequests).toEqual(["anthropic/claude-test", "google/gemini-test"])
    expect(h.providerRequests.map((request) => request.url)).toEqual([
      "https://api.anthropic.com/v1/messages",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent",
    ])
    expect(JSON.parse(h.providerRequests[0]?.body ?? "{}")).toMatchObject({ max_tokens: 16 })
    expect(JSON.parse(h.providerRequests[1]?.body ?? "{}")).toMatchObject({
      generationConfig: { maxOutputTokens: 16 },
    })
    expect(h.authorized).toHaveLength(2)
    expect(h.settled.map((hold) => hold.holdId)).toEqual(["h_1", "h_2"])
  })

  it("creates the budget on first use from the wrapper's defaults", async () => {
    const h = harness()
    const defaults = { unit: "USD", limits: [{ amount: "5", window: "month" as const }] }
    const openai = budgeted(
      createOpenAI,
      { unprice: h.unprice, budget: "customer:new", defaults, maxOutputTokens: 16 },
      { apiKey: "test", fetch: h.providerFetch }
    )
    await generateText({ model: openai("gpt-test"), prompt: "hello", maxRetries: 0 })
    expect(h.authorized).toEqual([
      {
        key: "customer:new",
        amount: expect.any(String),
        idempotencyKey: expect.any(String),
        ifMissing: defaults,
      },
    ])
  })

  it("sends no definition without defaults", async () => {
    const h = harness()
    const openai = budgeted(
      createOpenAI,
      { unprice: h.unprice, budget: "customer:a", maxOutputTokens: 16 },
      { apiKey: "test", fetch: h.providerFetch }
    )
    await generateText({ model: openai("gpt-test"), prompt: "hello", maxRetries: 0 })
    expect(h.authorized[0]?.ifMissing).toBeUndefined()
  })

  it("does not take a price table or model limits", () => {
    const h = harness()
    // @ts-expect-error pricing is catalog data now, not an option
    createUnpriceBudgetMiddleware({ unprice: h.unprice, getPricing: () => rates })
    // @ts-expect-error limits come with the catalog row
    createUnpriceBudgetMiddleware({ unprice: h.unprice, getModelLimits: () => limits })
  })
})
