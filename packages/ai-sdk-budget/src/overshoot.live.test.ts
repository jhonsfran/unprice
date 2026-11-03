import { writeFileSync } from "node:fs"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogle } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import { Unprice } from "@unprice/budgets"
import { type TokenPricing, usageCost } from "@unprice/budgets-ai"
import { generateText, isStepCount, jsonSchema, streamText, wrapLanguageModel } from "ai"
import { describe, expect, it } from "vitest"
import { createUnpriceBudgetMiddleware } from "./index"

/**
 * Measures the overshoot gap against real providers: for every physical model request, the hold
 * the middleware reserved against what the provider reports on the wire, priced at catalog rates.
 * The budget is an in-memory fake that allows every hold, so no Unprice backend is needed; the
 * provider calls are real and cost a few cents in total on the cheap models below.
 *
 *   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... GOOGLE_GENERATIVE_AI_API_KEY=... \
 *     pnpm --filter @unprice/ai-sdk-budget exec vitest run src/overshoot.live.test.ts
 *
 * Set OVERSHOOT_OUT to a file path to also write the rows as JSON.
 */
const keys = {
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  google: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
}
type Provider = keyof typeof keys

type CatalogRow = {
  id: string
  rates: TokenPricing
  tiers?: TokenPricing["tiers"]
  limits: { context: number; output: number }
}

// A runtime import keeps the services package out of this package's typecheck.
const catalogPath = "../../../internal/services/src/budgets/model-catalog.data.ts"

const MODELS: Record<Provider, string[]> = {
  openai: ["gpt-5-nano", "gpt-4.1-nano"],
  anthropic: ["claude-haiku-4-5"],
  google: ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
}

const mixed = [
  "予算は一つのキーに対するカウンターです。北京的天气今天很好，我们去公园散步吧。",
  "😀🚀🎉🔥💡🌍🍕🎸📚🧪",
  "export function inputBound(body: string, messages: number): number {\n\treturn body.length\n}",
  "Ærøskøbing — Zürich — Łódź — Ελληνικά — Русский — العربية — हिन्दी — ภาษาไทย",
].join("\n")
const longText = Array.from({ length: 24 }, (_, i) => `Section ${i}.\n${mixed}`).join("\n\n")
const lookupResult = JSON.stringify({
  items: Array.from({ length: 40 }, (_, i) => ({ sku: `S${i}`, note: mixed.slice(0, 60) })),
})
const puzzle =
  "A ledger has 7 accounts. Each transfer moves an integer amount between two accounts and no balance may go negative. Starting balances are 3,1,4,1,5,9,2. What is the minimum number of transfers to make all balances equal? Prove it."

type Case = {
  name: string
  mode: "generate" | "stream"
  maxOutputTokens: number
  prompt: string
  tools?: boolean
  providerOptions?: (provider: Provider) => Record<string, Record<string, unknown>> | undefined
}

const thinking = (provider: Provider) =>
  provider === "openai"
    ? { openai: { reasoningEffort: "high" } }
    : provider === "anthropic"
      ? { anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } } }
      : { google: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: false } } }

const CASES: Case[] = [
  { name: "short", mode: "generate", maxOutputTokens: 256, prompt: "Write a haiku about budgets." },
  {
    name: "long-mixed",
    mode: "generate",
    maxOutputTokens: 128,
    prompt: `${longText}\n\nSummarize the text above in one sentence.`,
  },
  {
    name: "stream-truncated",
    mode: "stream",
    maxOutputTokens: 64,
    prompt: "Count from 1 to 500, separated by commas. Do not stop early.",
  },
  {
    name: "tool-loop",
    mode: "generate",
    maxOutputTokens: 256,
    tools: true,
    prompt:
      "Look up item a, then item b, then item c, one call at a time, then answer in one line.",
  },
  {
    name: "thinking-squeeze",
    mode: "generate",
    maxOutputTokens: 1100,
    prompt: puzzle,
    providerOptions: thinking,
  },
  {
    name: "thinking-squeeze-stream",
    mode: "stream",
    maxOutputTokens: 1100,
    prompt: puzzle,
    providerOptions: thinking,
  },
]

type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number }

/** Provider usage as it crosses the wire, merged across a stream's events, last value wins. */
function wireUsage(provider: Provider, text: string): Usage | undefined {
  const events = text.trimStart().startsWith("{")
    ? [text]
    : text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
  const merged: Record<string, number> = {}
  const take = (value: unknown, prefix = "") => {
    if (typeof value !== "object" || value === null) return
    for (const [key, field] of Object.entries(value)) {
      if (typeof field === "number") merged[prefix + key] = field
      else if (typeof field === "object") take(field, `${prefix}${key}.`)
    }
  }
  for (const event of events) {
    let value: Record<string, unknown>
    try {
      value = JSON.parse(event) as Record<string, unknown>
    } catch {
      continue
    }
    const response = value.response as Record<string, unknown> | undefined
    const message = value.message as Record<string, unknown> | undefined
    take(value.usage ?? response?.usage ?? message?.usage ?? value.usageMetadata)
  }
  const n = (key: string) => merged[key] ?? 0
  if (Object.keys(merged).length === 0) return undefined
  switch (provider) {
    case "openai":
      return {
        input: n("input_tokens") - n("input_tokens_details.cached_tokens"),
        cacheRead: n("input_tokens_details.cached_tokens"),
        cacheWrite: 0,
        output: n("output_tokens"),
      }
    case "anthropic":
      return {
        input: n("input_tokens"),
        cacheRead: n("cache_read_input_tokens"),
        cacheWrite: n("cache_creation_input_tokens"),
        output: n("output_tokens"),
      }
    case "google":
      return {
        input: n("promptTokenCount") - n("cachedContentTokenCount") + n("toolUsePromptTokenCount"),
        cacheRead: n("cachedContentTokenCount"),
        cacheWrite: 0,
        output: n("candidatesTokenCount") + n("thoughtsTokenCount"),
      }
  }
}

type Row = {
  provider: Provider
  model: string
  case: string
  step: number
  hold?: number | undefined
  product?: number | undefined
  wire?: number | undefined
  overshoot?: number | undefined
  wireOut?: number | undefined
  wireIn?: number | undefined
  error?: string | undefined
}

function harness(provider: Provider, row: CatalogRow, maxOutputTokens: number) {
  const holds = new Map<string, number>()
  const settled = new Map<string, number>()
  const excess = new Map<string, number>()
  const holdByKey = new Map<string, string>()
  const order: string[] = []
  const wire: Promise<string>[] = []
  const balance = { remaining: "1000", held: "0", limits: [], asOf: Date.now() }
  const unprice = new Unprice({
    token: "test",
    baseUrl: "https://budgets.test",
    disableTelemetry: true,
    retry: { attempts: 0 },
    fetch: async (request) => {
      if (request.method === "GET")
        return Response.json({ budget: { balance: { ...balance, asOf: Date.now() } } })
      const body = (await request.json()) as Record<string, unknown>
      if (request.url.endsWith("/authorize")) {
        const holdId = `h_${holds.size + 1}`
        holds.set(holdId, Number(body.amount))
        holdByKey.set(String(body.idempotencyKey), holdId)
        order.push(holdId)
        return Response.json({
          allowed: true,
          holdId,
          amount: body.amount,
          expiresAt: Date.now() + 300_000,
          replayed: false,
          balance,
        })
      }
      if (request.url.endsWith("/record")) {
        const holdId = holdByKey.get(String(body.idempotencyKey).replace(/:excess$/, ""))
        if (holdId) excess.set(holdId, Number(body.amount))
        return Response.json({
          amount: body.amount,
          crossed: [],
          replayed: false,
          created: false,
          balance,
        })
      }
      const holdId = /h_\d+/.exec(request.url)?.[0] ?? String(body.holdId)
      settled.set(holdId, Number(body.amount))
      return Response.json({
        holdId,
        actual: body.amount,
        released: "0",
        expired: false,
        crossed: [],
        replayed: false,
        balance,
      })
    },
  })
  const adapter = createUnpriceBudgetMiddleware({
    unprice,
    budget: `live:${provider}`,
    models: { [row.id]: { rates: row.rates, tiers: row.tiers ?? [], limits: row.limits } },
    maxOutputTokens,
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      wire.push(response.clone().text())
      return response
    },
  })
  const settings = { apiKey: keys[provider] ?? "", fetch: adapter.fetch }
  const native: LanguageModelV4 =
    provider === "openai"
      ? createOpenAI(settings).responses(row.id.split("/")[1] ?? "")
      : provider === "anthropic"
        ? createAnthropic(settings).messages(row.id.split("/")[1] ?? "")
        : createGoogle(settings).chat(row.id.split("/")[1] ?? "")
  const model = wrapLanguageModel({ model: native, middleware: adapter.middleware })
  return { model, holds, settled, excess, order, wire }
}

const tools = {
  lookup: {
    description: "Look up one catalog item by its id and return its record.",
    inputSchema: jsonSchema<{ id: string }>({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    }),
    execute: async () => lookupResult,
  },
}

async function run(provider: Provider, row: CatalogRow, test: Case): Promise<Row[]> {
  const h = harness(provider, row, test.maxOutputTokens)
  const options = {
    model: h.model,
    prompt: test.prompt,
    maxRetries: 0,
    ...(test.tools ? { tools, stopWhen: isStepCount(4) } : {}),
    ...(test.providerOptions ? { providerOptions: test.providerOptions(provider) } : {}),
  } as Parameters<typeof generateText>[0]
  const base = { provider, model: row.id, case: test.name }
  let failure: string | undefined
  try {
    if (test.mode === "generate") await generateText(options)
    else {
      const result = streamText(options as Parameters<typeof streamText>[0])
      await result.consumeStream()
      await result.steps
    }
  } catch (error) {
    failure = error instanceof Error ? error.message.slice(0, 160) : String(error)
  }
  const bodies = await Promise.all(h.wire)
  const rows: Row[] = h.order.map((holdId, index) => {
    const hold = h.holds.get(holdId) ?? 0
    const product = (h.settled.get(holdId) ?? 0) + (h.excess.get(holdId) ?? 0)
    const usage = bodies[index] === undefined ? undefined : wireUsage(provider, bodies[index])
    const wire = usage
      ? usageCost(row.tiers ? { ...row.rates, tiers: row.tiers } : row.rates, usage)
      : undefined
    return {
      ...base,
      step: index + 1,
      hold,
      product,
      ...(wire === undefined
        ? {}
        : { wire, overshoot: wire - hold, wireIn: usage?.input, wireOut: usage?.output }),
    }
  })
  if (failure) rows.push({ ...base, step: rows.length + 1, error: failure })
  return rows
}

const providers = (Object.keys(keys) as Provider[]).filter((provider) => keys[provider])

describe.skipIf(providers.length === 0)("overshoot against real providers", () => {
  it(
    "measures every physical request's wire cost against its hold",
    { timeout: 600_000 },
    async () => {
      const { MODEL_CATALOG } = (await import(/* @vite-ignore */ catalogPath)) as {
        MODEL_CATALOG: CatalogRow[]
      }
      const rows: Row[] = []
      for (const provider of providers) {
        for (const model of MODELS[provider]) {
          const row = MODEL_CATALOG.find((entry) => entry.id === `${provider}/${model}`)
          if (!row) {
            rows.push({ provider, model, case: "-", step: 0, error: "not in catalog" })
            continue
          }
          for (const test of CASES) rows.push(...(await run(provider, row, test)))
        }
      }
      const fmt = (value: number | undefined) => (value === undefined ? "" : value.toFixed(8))
      console.table(
        rows.map((row) => ({
          model: row.model,
          case: row.case,
          step: row.step,
          hold: fmt(row.hold),
          product: fmt(row.product),
          wire: fmt(row.wire),
          "wire/hold": row.wire && row.hold ? (row.wire / row.hold).toFixed(3) : "",
          wireIn: row.wireIn ?? "",
          wireOut: row.wireOut ?? "",
          error: row.error ?? "",
        }))
      )
      const measured = rows.filter((row) => row.wire !== undefined)
      const over = measured.filter((row) => (row.overshoot ?? 0) > 1e-8)
      const drift = measured.filter((row) => Math.abs((row.product ?? 0) - (row.wire ?? 0)) > 1e-8)
      const spent = measured.reduce((sum, row) => sum + (row.wire ?? 0), 0)
      console.info(
        `requests ${measured.length} · over hold ${over.length} · product≠wire ${drift.length} · spent $${spent.toFixed(4)} at catalog rates`
      )
      if (process.env.OVERSHOOT_OUT)
        writeFileSync(process.env.OVERSHOOT_OUT, JSON.stringify(rows, null, 2))
      for (const row of measured) {
        const name = `${row.model} ${row.case} step ${row.step}`
        expect
          .soft(row.wire ?? 0, `${name}: wire cost within hold`)
          .toBeLessThanOrEqual((row.hold ?? 0) + 1e-8)
        expect
          .soft(row.product ?? 0, `${name}: product books the wire cost`)
          .toBeCloseTo(row.wire ?? 0, 8)
      }
    }
  )
})
