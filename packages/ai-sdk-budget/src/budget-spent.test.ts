import { createOpenAI } from "@ai-sdk/openai"
import { Unprice } from "@unprice/budgets"
import { generateText, jsonSchema, stepCountIs, streamText, tool } from "ai"
import { describe, expect, it } from "vitest"
import { budgetSpent, budgeted } from "./index"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const rates = { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 1 }
const limits = { context: 1_000_000, output: 4096 }

const toolCall = (index: number) =>
  json({
    id: `resp_${index}`,
    object: "response",
    created_at: 1_792_000_000,
    model: "gpt-test",
    status: "completed",
    output: [
      {
        type: "function_call",
        id: `fc_${index}`,
        call_id: `call_${index}`,
        name: "lookup",
        arguments: JSON.stringify({ q: `query ${index}` }),
        status: "completed",
      },
    ],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 14,
    },
  })

/** The remaining balance each settle answers with, in order; the budget runs dry on the second. */
function harness(remaining: readonly string[], maxOutputTokens = 16) {
  const authorized: string[] = []
  let settles = 0
  const balanceAt = (index: number) => ({
    remaining: remaining[Math.min(index, remaining.length - 1)] ?? "0",
    held: "0",
    limits: [],
    asOf: 1_792_000_000_000,
  })
  const unprice = new Unprice({
    token: "test",
    baseUrl: "https://budgets.test",
    disableTelemetry: true,
    retry: { attempts: 0 },
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = (await request.json()) as Record<string, string>
      if (url.pathname === "/v1/budgets/authorize") {
        authorized.push(body.idempotencyKey ?? "")
        return json({
          allowed: true,
          holdId: `h_${authorized.length}`,
          amount: body.amount,
          expiresAt: Date.now() + 300_000,
          replayed: false,
          created: false,
          balance: balanceAt(settles),
        })
      }
      if (url.pathname === "/v1/budgets/settle") {
        settles++
        return json({
          holdId: body.holdId,
          actual: body.amount,
          released: "0",
          expired: false,
          crossed: [],
          replayed: false,
          balance: balanceAt(settles),
        })
      }
      throw new Error(`Unexpected Unprice request ${url.pathname}`)
    },
  })
  let generation = 0
  const providerFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    generation++
    if (request.url.includes("input_tokens")) throw new Error("no count request expected")
    return toolCall(generation)
  }
  const openai = budgeted(
    createOpenAI,
    {
      unprice,
      budget: "customer:a",
      maxOutputTokens,
      models: { "openai/gpt-test": { rates, tiers: [], limits } },
    },
    { apiKey: "test", fetch: providerFetch }
  )
  const lookup = tool({
    inputSchema: jsonSchema<{ q: string }>({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    }),
    execute: async ({ q }) => `found ${q}`,
  })
  return { openai, lookup, authorized, generations: () => generation }
}

describe("budgetSpent", () => {
  it("stops the loop after the step whose settlement leaves less than the next step needs", async () => {
    // Step 1 settles with plenty left; step 2 leaves less than one minimal step (bound × 1 + 16 × 4
    // per million), so the loop ends there instead of running five tool steps.
    const h = harness(["0.5", "0.5", "0.00001"])
    const result = await generateText({
      model: h.openai("gpt-test"),
      prompt: "hello",
      tools: { lookup: h.lookup },
      stopWhen: [stepCountIs(5), budgetSpent()],
      maxOutputTokens: 16,
      maxRetries: 0,
    })
    expect(result.steps).toHaveLength(2)
    expect(h.generations()).toBe(2)
    expect(result.steps[0]?.providerMetadata?.unprice).toMatchObject({
      budget: "customer:a",
      holdId: "h_1",
      actual: "0.000025",
      remaining: "0.5",
      exceeded: false,
      exhausted: false,
    })
    expect(result.steps[1]?.providerMetadata?.unprice).toMatchObject({
      holdId: "h_2",
      remaining: "0.00001",
      exhausted: true,
    })
  })

  it("lets the loop run to its step count while the budget holds", async () => {
    const h = harness(["0.5"])
    const result = await generateText({
      model: h.openai("gpt-test"),
      prompt: "hello",
      tools: { lookup: h.lookup },
      stopWhen: [stepCountIs(3), budgetSpent()],
      maxOutputTokens: 16,
      maxRetries: 0,
    })
    expect(result.steps).toHaveLength(3)
    expect(result.steps.map((step) => step.providerMetadata?.unprice?.exhausted)).toEqual([
      false,
      false,
      false,
    ])
  })

  it("measures the next step at the output cap, not at the smallest answer", async () => {
    // With a 4096-token cap the next step reserves about 0.0164 (4096 × 4 per million plus the
    // prompt bound), so 0.01 left is exhausted even though a 16-token answer would still fit.
    const h = harness(["0.01"], 4096)
    const result = await generateText({
      model: h.openai("gpt-test"),
      prompt: "hello",
      tools: { lookup: h.lookup },
      stopWhen: [stepCountIs(5), budgetSpent()],
      maxRetries: 0,
    })
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]?.providerMetadata?.unprice).toMatchObject({
      remaining: "0.01",
      exhausted: true,
    })
    const plenty = harness(["0.5"], 4096)
    const more = await generateText({
      model: plenty.openai("gpt-test"),
      prompt: "hello",
      tools: { lookup: plenty.lookup },
      stopWhen: [stepCountIs(2), budgetSpent()],
      maxRetries: 0,
    })
    expect(more.steps).toHaveLength(2)
  })

  it("reports the same metadata on a stream's finish part", async () => {
    const h = harness(["0.00001"])
    const result = streamText({
      model: h.openai("gpt-test"),
      prompt: "hello",
      tools: { lookup: h.lookup },
      stopWhen: [stepCountIs(5), budgetSpent()],
      maxOutputTokens: 16,
      maxRetries: 0,
    })
    const steps = await result.steps
    expect(steps).toHaveLength(1)
    expect(steps[0]?.providerMetadata?.unprice).toMatchObject({ holdId: "h_1", exhausted: true })
  })
})
