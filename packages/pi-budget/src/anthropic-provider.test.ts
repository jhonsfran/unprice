import { type Context, Type } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { Unprice } from "@unprice/budgets"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { withUnpriceBudget } from "./index"

const jsonObject = z.record(z.unknown())
const input: Context = {
  systemPrompt: "Answer with local weather tools",
  tools: [
    {
      name: "weather",
      description: "Read weather",
      parameters: Type.Object({ city: Type.String() }),
    },
  ],
  messages: [{ role: "user", content: "Weather in Bogota?", timestamp: 0 }],
}

function responseStream(modelId: string, partial = false): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_native",
        type: "message",
        role: "assistant",
        model: modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 8,
          output_tokens: 0,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 2,
          cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 0 },
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Native reply" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4, output_tokens_details: { thinking_tokens: 1 } },
    },
    { type: "message_stop" },
  ]
  return new Response(
    (partial ? events.slice(0, 3) : events)
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } }
  )
}

function fixture(
  modelId = "claude-sonnet-4-6",
  auth: "apiKey" | "bearer" = "apiKey",
  partial = false
) {
  const native = anthropicProvider()
  const model = native.getModels().find((entry) => entry.id === modelId)
  if (model === undefined) throw new Error("Native Anthropic test model is missing")
  const order: string[] = []
  const amounts: number[] = []
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
  let deny = false
  const client = new Unprice({
    token: "budget-test",
    retry: { attempts: 0 },
    fetch: async (request) => {
      const body = jsonObject.parse(await request.json())
      if (request.url.endsWith("/authorize")) {
        order.push("authorize")
        amounts.push(Number(body.amount))
        if (deny)
          return Response.json(
            {
              error: {
                code: "BUDGET_EXCEEDED",
                message: "Limit exceeded",
                docs: "",
                requestId: "test",
                details: {
                  kind: "budget_exceeded",
                  blocked: {
                    limitId: "day",
                    window: "day",
                    remaining: "0",
                    held: "0",
                    resetsAt: Date.now() + 1000,
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
          expiresAt: Date.now() + 300_000,
          replayed: false,
          balance: { remaining: "10", held: body.amount, limits: [] },
        })
      }
      if (!request.url.endsWith("/settle")) throw new Error("Unexpected budget request")
      order.push("settle")
      amounts.push(Number(body.amount))
      return Response.json({})
    },
  })
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    order.push("generate")
    requests.push({
      url: request.url,
      headers: request.headers,
      body: jsonObject.parse(await request.json()),
    })
    return responseStream(model.id, partial)
  }
  const wrapped = withUnpriceBudget(native, {
    getBudget: () => client.budget("anthropic-customer"),
    maxOutputTokens: 2048,
  })
  const models = createModels({
    authContext: {
      env: async (name) => {
        if (auth === "apiKey" && name === "ANTHROPIC_API_KEY") return "sk-ant-api-test"
        if (auth === "bearer" && name === "ANTHROPIC_AUTH_TOKEN") return "bearer-test"
        return undefined
      },
      fileExists: async () => false,
    },
  })
  models.setProvider(wrapped)
  return {
    native,
    wrapped,
    models,
    model,
    fetch,
    order,
    amounts,
    requests,
    deny() {
      deny = true
    },
  }
}

describe("native Pi Anthropic budget transport", () => {
  it.each(["stream", "streamSimple", "complete", "completeSimple"] as const)(
    "authorizes Models.%s with native text/local tools and settles native SSE usage",
    async (method) => {
      const test = fixture()
      const response = test.models[method](test.model, input, {
        maxTokens: 2048,
        fetch: test.fetch,
        cacheRetention: "short",
      })
      const message = "result" in response ? await response.result() : await response
      expect(message).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "Native reply" }],
        usage: { input: 8, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 1, totalTokens: 17 },
      })
      expect(test.order).toEqual(["authorize", "generate", "settle"])
      expect(test.amounts[0]).toBe(3.78072)
      expect(test.amounts[1]).toBeCloseTo(0.00009585, 12)
      expect(test.requests).toHaveLength(1)
      const request = test.requests[0]
      expect(request?.url).toContain("/v1/messages")
      expect(request?.headers.get("x-api-key")).toBe("sk-ant-api-test")
      expect(request?.headers.get("anthropic-version")).toBe("2023-06-01")
      expect(request?.body).toMatchObject({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        stream: true,
        service_tier: "standard_only",
        tools: [{ name: "weather", input_schema: { type: "object" } }],
        system: [{ type: "text", cache_control: { type: "ephemeral" } }],
      })
      expect(request?.body).not.toHaveProperty("betas")
      expect(request?.body).not.toHaveProperty("speed")
      expect(request?.body).not.toHaveProperty("inference_geo")
    }
  )

  it("preserves the provider auth contract and header-owned bearer authentication", async () => {
    const test = fixture("claude-sonnet-4-6", "bearer")
    expect(test.wrapped.auth).toBe(test.native.auth)
    expect(test.wrapped.baseUrl).toBe(test.native.baseUrl)
    const auth = await test.models.getAuth("anthropic")
    expect(auth).toMatchObject({ auth: { headers: { Authorization: "Bearer bearer-test" } } })
    const message = await test.models.complete(test.model, input, { fetch: test.fetch })
    expect(message.stopReason).toBe("stop")
    expect(test.requests[0]?.headers.get("authorization")).toBe("Bearer bearer-test")
    expect(test.requests[0]?.headers.has("x-api-key")).toBe(false)
  })

  it("bounds an onPayload override after native serialization and preserves adaptive thinking", async () => {
    const test = fixture()
    const message = await test.models.complete(test.model, input, {
      fetch: test.fetch,
      thinkingEnabled: true,
      onPayload: (value) => ({
        ...jsonObject.parse(value),
        max_tokens: 100_000,
        speed: "fast",
        inference_geo: "us",
        betas: ["server-side-fallback-2026-07-01", "interleaved-thinking-2025-05-14"],
      }),
    })
    expect(message.stopReason).toBe("stop")
    expect(test.requests[0]?.body).toMatchObject({
      max_tokens: 2048,
      thinking: { type: "adaptive", display: "summarized" },
      speed: "standard",
      inference_geo: "global",
    })
    expect(test.requests[0]?.headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14")
  })

  it("accepts the native current-model effort and binding defaults for plain text", async () => {
    const test = fixture("claude-opus-5")
    const message = await test.models.complete(
      test.model,
      { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
      { fetch: test.fetch }
    )
    expect(message.stopReason).toBe("stop")
    expect(test.requests[0]?.body).toMatchObject({
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      output_config: { effort: "high" },
      messages: [
        { role: "user" },
        { role: "system", content: [], output_config: { effort: "high" } },
      ],
    })
  })

  it("serializes local tool results and thinking history through the native adapter", async () => {
    const test = fixture()
    const previous = await test.models.complete(test.model, input, { fetch: test.fetch })
    const history: Context = {
      ...input,
      messages: [
        ...input.messages,
        {
          ...previous,
          content: [
            { type: "thinking", thinking: "Check weather", thinkingSignature: "signed" },
            {
              type: "toolCall",
              id: "call_weather",
              name: "weather",
              arguments: { city: "Bogota" },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "call_weather",
          toolName: "weather",
          content: [{ type: "text", text: "Clear" }],
          isError: false,
          timestamp: 1,
        },
      ],
    }
    const message = await test.models.complete(test.model, history, {
      fetch: test.fetch,
      thinkingEnabled: true,
    })
    expect(message.stopReason).toBe("stop")
    expect(test.requests[1]?.body).toMatchObject({
      messages: [
        { role: "user" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Check weather", signature: "signed" },
            { type: "tool_use", id: "call_weather", name: "weather", input: { city: "Bogota" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_weather",
              content: "Clear",
            },
          ],
        },
      ],
    })
    expect(test.order).toEqual([
      "authorize",
      "generate",
      "settle",
      "authorize",
      "generate",
      "settle",
    ])
  })

  it("rejects unsupported native inline tool declarations before authorization", async () => {
    const test = fixture("claude-opus-5")
    let nativePayload: Record<string, unknown> | undefined
    const message = await test.models.complete(test.model, input, {
      fetch: test.fetch,
      onPayload: (payload) => {
        nativePayload = jsonObject.parse(payload)
      },
    })
    expect(nativePayload?.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ defer_loading: true })])
    )
    expect(message.stopReason).toBe("error")
    expect(test.order).toEqual([])
    expect(test.requests).toEqual([])
  })

  it("rejects native default fallback arrays before authorization", async () => {
    const test = fixture("claude-fable-5")
    let nativePayload: Record<string, unknown> | undefined
    const message = await test.models.complete(
      test.model,
      { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
      {
        fetch: test.fetch,
        onPayload: (payload) => {
          nativePayload = jsonObject.parse(payload)
        },
      }
    )
    expect(nativePayload).toMatchObject({
      fallbacks: [{ model: "claude-opus-4-8" }, { model: "claude-opus-5" }],
    })
    expect(message.stopReason).toBe("error")
    expect(test.order).toEqual([])
    expect(test.requests).toEqual([])
  })

  it.each([
    { tools: [{ type: "web_search_20250305", name: "web_search" }] },
    { context_management: { edits: [{ type: "compact_20260112" }] } },
    { fallbacks: [{ model: "other" }] },
    { cache_control: { type: "ephemeral", ttl: "1h" } },
    {
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://example.test/image" } }],
        },
      ],
    },
  ])("rejects unsafe onPayload additions before authorization %j", async (unsupported) => {
    const test = fixture()
    const message = await test.models.complete(test.model, input, {
      fetch: test.fetch,
      maxRetries: 2,
      onPayload: (value) => ({ ...jsonObject.parse(value), ...unsupported }),
    })
    expect(message.stopReason).toBe("error")
    expect(test.order).toEqual([])
    expect(test.requests).toEqual([])
  })

  it("rejects native long cache retention before authorization", async () => {
    const test = fixture()
    const message = await test.models.complete(test.model, input, {
      fetch: test.fetch,
      cacheRetention: "long",
    })
    expect(message.stopReason).toBe("error")
    expect(test.order).toEqual([])
  })

  it("settles the full hold when an abort leaves only preliminary input usage", async () => {
    const test = fixture("claude-sonnet-4-6", "apiKey", true)
    const controller = new AbortController()
    const seen: string[] = []
    const message = await test.models.complete(test.model, input, {
      fetch: test.fetch,
      signal: controller.signal,
      onProviderStreamEvent: (value) => {
        const type = z.string().parse(jsonObject.parse(value).type)
        seen.push(type)
        if (type === "content_block_delta") controller.abort()
      },
    })
    expect(seen).toEqual(["message_start", "content_block_start", "content_block_delta"])
    expect(message).toMatchObject({
      stopReason: "aborted",
      usage: { input: 8, cacheRead: 2, cacheWrite: 3, output: 0 },
    })
    expect(test.order).toEqual(["authorize", "generate", "settle"])
    expect(message.usage.cost.total).toBeCloseTo(0.00003585, 12)
    expect(test.amounts).toEqual([3.78072, 3.78072])
  })

  it("denies generation without a provider request", async () => {
    const test = fixture()
    test.deny()
    const message = await test.models.complete(test.model, input, { fetch: test.fetch })
    expect(message).toMatchObject({
      stopReason: "error",
      errorMessage: "The budget cannot cover this call.",
    })
    expect(test.order).toEqual(["authorize"])
    expect(test.requests).toEqual([])
  })
})
