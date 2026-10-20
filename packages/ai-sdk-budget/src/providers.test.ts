import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogle } from "@ai-sdk/google"
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { Unprice } from "@unprice/budgets"
import { type BudgetProtocol, type ModelLimits, inputBound } from "@unprice/budgets-ai"
import { generateText, jsonSchema, streamText, wrapLanguageModel } from "ai"
import { describe, expect, it, vi } from "vitest"
import { createUnpriceBudgetMiddleware } from "./index"

type AddedProtocol = Exclude<BudgetProtocol, "openai-responses">
const protocols: AddedProtocol[] = ["anthropic-messages", "google-generative-ai"]
const catalogIds: Record<AddedProtocol, string> = {
  "anthropic-messages": "anthropic/claude-test",
  "google-generative-ai": "google/gemini-test",
}
const pricing = { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 1.25 }
const limits = { context: 100, output: 2048 }
const balance = { remaining: "1", held: "0", limits: [], asOf: 1_792_000_000_000 }
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const rawStream = (chunks: readonly unknown[]) =>
  new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
const anthropicUsage = {
  input_tokens: 8,
  output_tokens: 4,
  output_tokens_details: { thinking_tokens: 1 },
  cache_creation_input_tokens: 3,
  cache_read_input_tokens: 2,
  cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 0 },
}
const googleUsage = {
  promptTokenCount: 13,
  candidatesTokenCount: 3,
  thoughtsTokenCount: 1,
  cachedContentTokenCount: 2,
  totalTokenCount: 17,
}

function providerResponse(protocol: AddedProtocol, toolReply: boolean) {
  if (protocol === "anthropic-messages") {
    return {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "thinking", thinking: "reason", signature: "signature" },
        toolReply
          ? { type: "tool_use", id: "tool_1", name: "lookup", input: { id: "a" } }
          : { type: "text", text: "answer" },
      ],
      stop_reason: toolReply ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: anthropicUsage,
    }
  }
  return {
    responseId: "google_1",
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { text: "reason", thought: true },
            toolReply
              ? { functionCall: { name: "lookup", args: { id: "a" } } }
              : { text: "answer" },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: googleUsage,
  }
}

function providerStream(protocol: AddedProtocol, gate?: Promise<void>) {
  const chunks =
    protocol === "anthropic-messages"
      ? [
          {
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-test",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { ...anthropicUsage, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "reason" },
          },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: anthropicUsage,
          },
          { type: "message_stop" },
        ]
      : [
          {
            responseId: "google_1",
            candidates: [
              { content: { role: "model", parts: [{ text: "reason", thought: true }] } },
            ],
          },
          {
            responseId: "google_1",
            candidates: [
              { content: { role: "model", parts: [{ text: "answer" }] }, finishReason: "STOP" },
            ],
            usageMetadata: googleUsage,
          },
        ]
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const chunk of chunks.slice(0, -1)) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))
        }
        await gate
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunks.at(-1))}\n\n`))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  )
}

function harness(
  protocol: AddedProtocol,
  options: {
    denied?: boolean
    key?: string
    modelLimits?: ModelLimits
    maxOutputTokens?: number
    toolReply?: boolean
    streamGate?: Promise<void>
    settleGate?: Promise<void>
    streamChunks?: readonly unknown[]
    jsonResponse?: unknown
    unknownModel?: boolean
  } = {}
) {
  const authorizations: unknown[] = []
  const settlements: unknown[] = []
  const requests: Request[] = []
  const unprice = new Unprice({
    token: "test",
    baseUrl: "https://budgets.test",
    disableTelemetry: true,
    retry: { attempts: 0 },
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/v1/budgets/models")
        return json({ version: "2026-10-20", models: [] })
      const body: unknown = await request.json()
      if (request.url.endsWith("/authorize")) {
        authorizations.push(body)
        if (options.denied)
          return json(
            {
              error: {
                code: "BUDGET_EXCEEDED",
                message: "Denied",
                requestId: "denied",
                docs: "https://docs.unprice.dev",
                details: {
                  kind: "budget_exceeded",
                  balance,
                  blocked: {
                    limitId: "month",
                    window: "month",
                    remaining: "0",
                    held: "0",
                    resetsAt: 1_800_000_000_000,
                    remedy: "wait_for_reset",
                  },
                },
              },
            },
            402
          )
        if (typeof body !== "object" || body === null || !("amount" in body))
          throw new Error("Invalid test authorization")
        return json({
          allowed: true,
          amount: body.amount,
          holdId: `h_${authorizations.length}`,
          expiresAt: Date.now() + 300_000,
          replayed: false,
          balance,
        })
      }
      settlements.push(body)
      await options.settleGate
      return json({
        holdId: "h_1",
        actual: "0",
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
    budget: options.key ?? protocol,
    models: options.unknownModel
      ? {}
      : {
          [catalogIds[protocol]]: {
            rates: pricing,
            tiers: [],
            limits: options.modelLimits ?? limits,
          },
        },
    maxOutputTokens: options.maxOutputTokens ?? 4096,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request.clone())
      const body: unknown = await request.clone().json()
      const streaming =
        protocol === "anthropic-messages"
          ? typeof body === "object" && body !== null && "stream" in body && body.stream === true
          : new URL(request.url).pathname.endsWith(":streamGenerateContent")
      return streaming
        ? options.streamChunks
          ? rawStream(options.streamChunks)
          : providerStream(protocol, options.streamGate)
        : json(options.jsonResponse ?? providerResponse(protocol, options.toolReply ?? false))
    },
  })
  const model = wrapLanguageModel({
    model:
      protocol === "anthropic-messages"
        ? createAnthropic({ apiKey: "test", fetch: adapter.fetch }).messages("claude-test")
        : createGoogle({ apiKey: "test", fetch: adapter.fetch }).chat("gemini-test"),
    middleware: adapter.middleware,
  })
  return { adapter, model, requests, authorizations, settlements }
}

const generate = (model: LanguageModelV4) => generateText({ model, prompt: "hello", maxRetries: 0 })

/**
 * The hold the cap requires for the body the provider received: its byte bound at the highest
 * input rate (cacheWrite, 1.25) plus the output limit at 4, rounded up at eight decimals and
 * formatted as the API carries amounts. Stated here on its own so the test does not borrow the
 * adapter's arithmetic.
 */
async function fullHold(h: ReturnType<typeof harness>, outputTokens = 2048): Promise<string> {
  const request = h.requests[0]
  if (!request) throw new Error("Missing provider request")
  const body = await request.clone().text()
  const native = JSON.parse(body) as Record<string, unknown>
  const messages = Array.isArray(native.messages)
    ? native.messages.length + (native.system === undefined ? 0 : 1)
    : (native.contents as unknown[]).length + (native.systemInstruction === undefined ? 0 : 1)
  const cost = (inputBound(body, messages) * 1.25 + outputTokens * 4) / 1_000_000
  return (Math.ceil(cost * 100_000_000) / 100_000_000).toFixed(8).replace(/\.?0+$/, "")
}

async function nativeParts(model: LanguageModelV4, includeRawChunks = false) {
  const result = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    includeRawChunks,
  })
  const parts: LanguageModelV4StreamPart[] = []
  const reader = result.stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return parts
    parts.push(value)
  }
}

describe.each(protocols)("AI SDK %s", (protocol) => {
  const actual = protocol === "anthropic-messages" ? "0.00002875" : "0.000028"

  it("uses the native JSON serializer, trusted input bound, and cache/reasoning usage", async () => {
    const h = harness(protocol)
    const result = await generate(h.model)
    expect(result.text).toBe("answer")
    expect(result.usage.inputTokens).toBe(13)
    expect(result.usage.outputTokens).toBe(4)
    expect(h.authorizations).toMatchObject([{ amount: await fullHold(h), key: protocol }])
    expect(h.settlements).toMatchObject([{ amount: actual }])
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]?.url).not.toMatch(/count/)
    expect(h.requests[0]?.headers.has("x-unprice-budget-call")).toBe(false)
    const body: unknown = await h.requests[0]?.json()
    expect(body).toMatchObject(
      protocol === "anthropic-messages"
        ? { model: "claude-test", max_tokens: 2048, service_tier: "standard_only" }
        : { generationConfig: { maxOutputTokens: 2048, responseModalities: ["TEXT"] } }
    )
  })

  it("uses native SSE and does not count reasoning twice", async () => {
    const h = harness(protocol)
    const result = streamText({ model: h.model, prompt: "hello", maxRetries: 0 })
    const parts: string[] = []
    for await (const text of result.textStream) parts.push(text)
    expect(parts.join("")).toBe("answer")
    expect(h.requests).toHaveLength(1)
    expect(h.settlements).toMatchObject([{ amount: actual }])
    expect(h.requests[0]?.headers.has("x-unprice-budget-call")).toBe(false)
  })

  it.each([false, true])("preserves the caller's raw event option %s", async (includeRawChunks) => {
    const h = harness(protocol)
    const parts = await nativeParts(h.model, includeRawChunks)
    expect(parts.some((part) => part.type === "raw")).toBe(includeRawChunks)
    expect(h.settlements).toMatchObject([{ amount: actual }])
  })

  it("blocks all provider requests when the budget denies the hold", async () => {
    const h = harness(protocol, { denied: true })
    await expect(generate(h.model)).rejects.toMatchObject({ name: "BudgetExceededError" })
    expect(h.requests).toEqual([])
    expect(h.settlements).toEqual([])
  })

  it("clamps native output before serialization to the model's limit", async () => {
    const h = harness(protocol, { modelLimits: { context: 100, output: 1024 } })
    await generate(h.model)
    const body: unknown = await h.requests[0]?.clone().json()
    expect(body).toMatchObject(
      protocol === "anthropic-messages"
        ? { max_tokens: 1024 }
        : { generationConfig: { maxOutputTokens: 1024 } }
    )
    expect(h.authorizations).toMatchObject([{ amount: await fullHold(h, 1024) }])
  })

  it("supports local function calls with their native usage", async () => {
    const h = harness(protocol, { toolReply: true })
    const result = await generateText({
      model: h.model,
      prompt: "lookup a",
      maxRetries: 0,
      tools: {
        lookup: {
          inputSchema: jsonSchema({
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          }),
        },
      },
    })
    expect(result.toolCalls).toMatchObject([{ toolName: "lookup", input: { id: "a" } }])
    expect(h.settlements).toMatchObject([{ amount: actual }])
  })

  it("delays native finish until settlement succeeds", async () => {
    const gate = Promise.withResolvers<void>()
    const h = harness(protocol, { settleGate: gate.promise })
    const result = streamText({ model: h.model, prompt: "hello", maxRetries: 0 })
    const chunks: string[] = []
    const reading = (async () => {
      for await (const part of result.fullStream) chunks.push(part.type)
    })()
    await vi.waitFor(() => expect(h.settlements).toHaveLength(1))
    expect(chunks).not.toContain("finish")
    gate.resolve()
    await reading
    expect(chunks).toContain("finish")
  })

  it("settles the full trusted envelope when a native stream is cancelled", async () => {
    const gate = Promise.withResolvers<void>()
    const h = harness(protocol, { streamGate: gate.promise })
    const result = await h.model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })
    await result.stream.cancel()
    expect(h.settlements).toMatchObject([{ amount: await fullHold(h) }])
    gate.resolve()
  })

  it("rejects invalid resolved limits before authorization or generation", async () => {
    const h = harness(protocol, { modelLimits: { context: 0, output: 2048 } })
    await expect(generate(h.model)).rejects.toThrow("model limits")
    expect(h.authorizations).toEqual([])
    expect(h.requests).toEqual([])
  })

  it("rejects invalid configured output limits before clamping to a model limit", () => {
    expect(() => harness(protocol, { maxOutputTokens: Number.POSITIVE_INFINITY })).toThrow(
      "maxOutputTokens"
    )
    expect(() => harness(protocol, { maxOutputTokens: 15 })).toThrow("maxOutputTokens")
  })

  it("rejects new serialized fields before authorization or generation", async () => {
    const h = harness(protocol)
    const mutate: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const body: unknown = await request.clone().json()
      if (typeof body !== "object" || body === null)
        throw new Error("Expected native request object")
      return h.adapter.fetch(
        new Request(request, { body: JSON.stringify({ ...body, unpricedOperation: true }) })
      )
    }
    const model = wrapLanguageModel({
      model:
        protocol === "anthropic-messages"
          ? createAnthropic({ apiKey: "test", fetch: mutate }).messages("claude-test")
          : createGoogle({ apiKey: "test", fetch: mutate }).chat("gemini-test"),
      middleware: h.adapter.middleware,
    })
    await expect(generate(model)).rejects.toThrow("Unsupported budgeted")
    expect(h.authorizations).toEqual([])
    expect(h.requests).toEqual([])
  })
})

describe("native terminal usage evidence", () => {
  it("settles measured Anthropic usage for a native JSON refusal", async () => {
    const h = harness("anthropic-messages", {
      jsonResponse: {
        ...providerResponse("anthropic-messages", false),
        content: [{ type: "text", text: "I cannot answer." }],
        stop_reason: "refusal",
      },
    })
    const result = await generate(h.model)
    expect(result.finishReason).toBe("content-filter")
    expect(h.settlements).toMatchObject([{ amount: "0.00002875" }])
  })

  it("settles measured Anthropic usage for a native SSE refusal", async () => {
    const h = harness("anthropic-messages", {
      streamChunks: [
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...anthropicUsage, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "I cannot answer." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "refusal", stop_sequence: null },
          usage: anthropicUsage,
        },
        { type: "message_stop" },
      ],
    })
    const parts = await nativeParts(h.model)
    expect(parts.find((part) => part.type === "finish")).toMatchObject({
      finishReason: { unified: "content-filter", raw: "refusal" },
    })
    expect(h.settlements).toMatchObject([{ amount: "0.00002875" }])
  })

  it.each([false, true])(
    "keeps the full Gemini hold when earlier usage precedes later content, terminal %s",
    async (terminal) => {
      const h = harness("google-generative-ai", {
        streamChunks: [
          {
            candidates: [{ content: { parts: [{ text: "early" }] } }],
            usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 1, totalTokenCount: 14 },
          },
          {
            candidates: [
              {
                content: { parts: [{ text: "later" }] },
                ...(terminal ? { finishReason: "STOP" } : {}),
              },
            ],
          },
        ],
      })
      const parts = await nativeParts(h.model)
      expect(parts.some((part) => part.type === "finish")).toBe(true)
      expect(h.settlements).toMatchObject([{ amount: await fullHold(h) }])
    }
  )

  it("uses Gemini usage received after terminal content", async () => {
    const h = harness("google-generative-ai", {
      streamChunks: [
        { candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }] },
        { usageMetadata: googleUsage },
      ],
    })
    await nativeParts(h.model)
    expect(h.settlements).toMatchObject([{ amount: "0.000028" }])
  })

  it("keeps the full Gemini hold if content follows terminal usage", async () => {
    const h = harness("google-generative-ai", {
      streamChunks: [
        {
          candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
          usageMetadata: googleUsage,
        },
        { candidates: [{ content: { parts: [{ text: "later" }] } }] },
      ],
    })
    await nativeParts(h.model)
    expect(h.settlements).toMatchObject([{ amount: await fullHold(h) }])
  })

  it("keeps the full Gemini hold if terminal usage omits output counts", async () => {
    const h = harness("google-generative-ai", {
      streamChunks: [
        {
          candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 13 },
        },
      ],
    })
    await nativeParts(h.model)
    expect(h.settlements).toMatchObject([{ amount: await fullHold(h) }])
  })

  it("keeps the full Anthropic hold without final message_delta usage", async () => {
    const h = harness("anthropic-messages", {
      streamChunks: [
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...anthropicUsage, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ],
    })
    await nativeParts(h.model)
    expect(h.settlements).toMatchObject([{ amount: await fullHold(h) }])
  })

  it("keeps the full Anthropic hold for unknown JSON completion", async () => {
    const h = harness("anthropic-messages", {
      jsonResponse: { ...providerResponse("anthropic-messages", false), stop_reason: null },
    })
    await generate(h.model)
    expect(h.settlements).toMatchObject([{ amount: await fullHold(h) }])
  })

  it("keeps the full Anthropic hold for an unknown streaming completion", async () => {
    const h = harness("anthropic-messages", {
      streamChunks: [
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...anthropicUsage, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "compaction", stop_sequence: null },
          usage: anthropicUsage,
        },
        { type: "message_stop" },
      ],
    })
    await nativeParts(h.model)
    expect(h.settlements).toMatchObject([{ amount: await fullHold(h) }])
  })
})

describe("explicit provider configuration", () => {
  it.each(protocols)(
    "refuses a %s model the catalog does not know before any hold or provider call",
    async (protocol) => {
      const h = harness(protocol, { unknownModel: true })
      await expect(generate(h.model)).rejects.toThrow(catalogIds[protocol])
      expect(h.authorizations).toEqual([])
      expect(h.requests).toEqual([])
    }
  )

  it("keeps concurrent providers, limits, and budget keys separate", async () => {
    const anthropic = harness("anthropic-messages", {
      key: "customer:a",
      modelLimits: { context: 100, output: 1024 },
    })
    const google = harness("google-generative-ai", { key: "customer:b" })
    await Promise.all([generate(anthropic.model), generate(google.model)])
    expect(anthropic.authorizations).toMatchObject([
      { key: "customer:a", amount: await fullHold(anthropic, 1024) },
    ])
    expect(google.authorizations).toMatchObject([
      { key: "customer:b", amount: await fullHold(google) },
    ])
    expect(anthropic.settlements).toMatchObject([{ amount: "0.00002875" }])
    expect(google.settlements).toMatchObject([{ amount: "0.000028" }])
  })

  it("rejects Anthropic one-hour cache writes before generation", async () => {
    const h = harness("anthropic-messages")
    await expect(
      generateText({
        model: h.model,
        maxRetries: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "hello",
                providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
              },
            ],
          },
        ],
      })
    ).rejects.toThrow()
    expect(h.requests).toEqual([])
    expect(h.authorizations).toEqual([])
  })

  it("supports Anthropic five-minute cache writes and bounded thinking", async () => {
    const h = harness("anthropic-messages")
    await generateText({
      model: h.model,
      maxRetries: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
              providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
            },
          ],
        },
      ],
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } },
    })
    const body: unknown = await h.requests[0]?.json()
    expect(body).toMatchObject({
      max_tokens: 2048,
      thinking: { type: "enabled", budget_tokens: 1024 },
    })
    expect(h.settlements).toMatchObject([{ amount: "0.00002875" }])
  })

  it("rejects Gemini explicit cached content before generation", async () => {
    const h = harness("google-generative-ai")
    await expect(
      generateText({
        model: h.model,
        prompt: "hello",
        maxRetries: 0,
        providerOptions: { google: { cachedContent: "cachedContents/private" } },
      })
    ).rejects.toThrow()
    expect(h.requests).toEqual([])
    expect(h.authorizations).toEqual([])
  })

  it("supports bounded Gemini thinking through the native serializer", async () => {
    const h = harness("google-generative-ai")
    await generateText({
      model: h.model,
      prompt: "hello",
      maxRetries: 0,
      providerOptions: {
        google: { thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } },
      },
    })
    const body: unknown = await h.requests[0]?.json()
    expect(body).toMatchObject({
      generationConfig: {
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
      },
    })
    expect(h.settlements).toMatchObject([{ amount: "0.000028" }])
  })

  it("rejects native hosted tools before authorization or generation", async () => {
    const anthropic = harness("anthropic-messages")
    await expect(
      anthropic.model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [
          {
            type: "provider",
            id: "anthropic.web_search_20250305",
            name: "search",
            args: { maxUses: 1 },
          },
        ],
      })
    ).rejects.toThrow()
    const google = harness("google-generative-ai")
    await expect(
      google.model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [{ type: "provider", id: "google.google_search", name: "search", args: {} }],
      })
    ).rejects.toThrow()
    expect(anthropic.requests).toEqual([])
    expect(anthropic.authorizations).toEqual([])
    expect(google.requests).toEqual([])
    expect(google.authorizations).toEqual([])
  })

  it("rejects Gemini Interactions requests before generation", async () => {
    const h = harness("google-generative-ai")
    const model = wrapLanguageModel({
      model: createGoogle({ apiKey: "test", fetch: h.adapter.fetch }).interactions("gemini-test"),
      middleware: h.adapter.middleware,
    })
    await expect(generate(model)).rejects.toThrow()
    expect(h.requests).toEqual([])
    expect(h.authorizations).toEqual([])
  })
})
