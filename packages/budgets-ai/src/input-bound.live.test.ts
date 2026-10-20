import { describe, expect, it } from "vitest"
import { inputBound } from "./input-bound"

/**
 * Checks the byte bound against the providers' own token counts. It runs only with provider keys
 * in the environment, so CI and a machine without keys skip it. Each count endpoint is free.
 *
 *   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... GOOGLE_GENERATIVE_AI_API_KEY=... \
 *     pnpm --filter @unprice/budgets-ai exec vitest run src/input-bound.live.test.ts
 */
const keys = {
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  google: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
}

const samples: Record<string, string> = {
  english:
    "The budget is a counter on one key. Before each model step the adapter reserves a bound and sets the output limit so the step cannot cost more than the hold.",
  cjk: "予算は一つのキーに対するカウンターです。各モデルステップの前に、アダプターは上限を予約し、出力制限を設定します。北京的天气今天很好，我们去公园散步吧。",
  emoji: "😀🚀🎉🔥💡🌍🍕🎸📚🧪 😀🚀🎉🔥💡🌍🍕🎸📚🧪 😀🚀🎉🔥💡🌍🍕🎸📚🧪",
  code: "export function inputBound(body: string, messages: number): number {\n\tconst bytes = new TextEncoder().encode(body).length\n\treturn bytes + 8 * messages + 32\n}\n",
  mixed:
    "Ærøskøbing — Zürich — Łódź — Reykjavík — İstanbul — Ελληνικά — Русский — العربية — हिन्दी — ภาษาไทย",
  repeated: "ab ".repeat(400),
  json: JSON.stringify({
    customer: { id: "c_1", plan: "pro" },
    items: Array.from({ length: 20 }, (_, i) => ({ sku: `S${i}`, qty: i })),
  }),
}

const tool = {
  name: "search",
  description: "Search the product catalog by free text and return the top matches.",
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "The query" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    required: ["q"],
  },
}

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${await response.text()}`)
  return (await response.json()) as Record<string, unknown>
}

type Counted = { count: number; bound: number }

function check(name: string, counted: Counted) {
  const ratio = (counted.bound / counted.count).toFixed(2)
  console.info(`${name}: count ${counted.count}, bound ${counted.bound}, bound/count ${ratio}`)
  expect(counted.count, name).toBeLessThanOrEqual(counted.bound)
}

describe.skipIf(!keys.openai)("OpenAI count against the byte bound", () => {
  it.each(Object.entries(samples))("%s", async (name, text) => {
    const body = {
      model: "gpt-5",
      instructions: "You are terse.",
      input: text,
      tools: [{ type: "function", ...tool }],
    }
    const answer = await post(
      "https://api.openai.com/v1/responses/input_tokens",
      { authorization: `Bearer ${keys.openai}` },
      body
    )
    check(name, { count: Number(answer.input_tokens), bound: inputBound(JSON.stringify(body), 2) })
  })
})

describe.skipIf(!keys.anthropic)("Anthropic count against the byte bound", () => {
  it.each(Object.entries(samples))("%s", async (name, text) => {
    const body = {
      model: "claude-sonnet-4-5",
      system: "You are terse.",
      messages: [{ role: "user", content: text }],
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }],
    }
    const answer = await post(
      "https://api.anthropic.com/v1/messages/count_tokens",
      { "x-api-key": keys.anthropic ?? "", "anthropic-version": "2023-06-01" },
      body
    )
    check(name, { count: Number(answer.input_tokens), bound: inputBound(JSON.stringify(body), 2) })
  })
})

describe.skipIf(!keys.google)("Gemini count against the byte bound", () => {
  it.each(Object.entries(samples))("%s", async (name, text) => {
    const request = {
      systemInstruction: { parts: [{ text: "You are terse." }] },
      contents: [{ role: "user", parts: [{ text }] }],
      tools: [
        {
          functionDeclarations: [
            { name: tool.name, description: tool.description, parameters: tool.parameters },
          ],
        },
      ],
    }
    const answer = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:countTokens?key=${keys.google}`,
      {},
      { generateContentRequest: { model: "models/gemini-2.5-pro", ...request } }
    )
    check(name, {
      count: Number(answer.totalTokens),
      bound: inputBound(JSON.stringify(request), 2),
    })
  })
})
