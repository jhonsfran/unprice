import { type Model, Type } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { googleProvider } from "@earendil-works/pi-ai/providers/google"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"
import { Unprice } from "@unprice/budgets"
import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import { withUnpriceBudget } from "./index"

const model: Model<"google-generative-ai"> = {
  id: "gemini-2.5-flash",
  name: "Gemini fixture",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://provider.test/v1beta",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 100000,
  maxTokens: 8192,
}
const context = normalizeContext({
  systemPrompt: "Be concise",
  messages: [{ role: "user", content: "Hello", timestamp: 1 }],
})
const usage = {
  promptTokenCount: 100,
  cachedContentTokenCount: 20,
  candidatesTokenCount: 3,
  thoughtsTokenCount: 2,
  totalTokenCount: 105,
}
const complete = {
  candidates: [
    {
      content: { parts: [{ text: "Hello", thoughtSignature: "dGV4dC1zaWduYXR1cmU=" }] },
      finishReason: "STOP",
    },
  ],
  usageMetadata: usage,
}
const object = z.record(z.string(), z.unknown())

function sse(events: unknown[], split = false) {
  const bytes = new TextEncoder().encode(
    events.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join("")
  )
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (split)
          for (let index = 0; index < bytes.length; index += 3)
            controller.enqueue(bytes.slice(index, index + 3))
        else controller.enqueue(bytes)
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  )
}

function fixture(replies: (() => Response)[]) {
  const order: string[] = []
  const amounts: number[] = []
  const requests: Request[] = []
  const client = new Unprice({
    token: "test",
    retry: { attempts: 0 },
    fetch: async (request) => {
      const body = object.parse(await request.json())
      if (request.url.endsWith("/authorize")) {
        order.push("authorize")
        amounts.push(Number(body.amount))
        return Response.json({
          holdId: `hold_${amounts.length}`,
          amount: body.amount,
          expiresAt: Date.now() + 300000,
          replayed: false,
          balance: { remaining: "1", held: body.amount, limits: [] },
        })
      }
      order.push("settle")
      amounts.push(Number(body.amount))
      return Response.json({})
    },
  })
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    order.push("generate")
    requests.push(request)
    const reply = replies.shift()
    if (!reply) throw new Error("Unexpected provider retry")
    return reply()
  }
  const provider = withUnpriceBudget(googleProvider(), {
    getBudget: () => client.budget("customer"),
    maxOutputTokens: 4096,
  })
  return { provider, fetch, order, amounts, requests }
}

describe("budgeted Pi Gemini transport", () => {
  it("uses native Pi codecs, the shared hold gate, final caps, SSE parsing, and usage", async () => {
    const test = fixture([
      () =>
        sse(
          [
            {
              responseId: "response-1",
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: "Think",
                        thought: true,
                        thoughtSignature: "dGhvdWdodC1zaWduYXR1cmU=",
                      },
                    ],
                  },
                },
              ],
            },
            complete,
          ],
          true
        ),
    ])
    const events: string[] = []
    const raw: unknown[] = []
    const stream = test.provider.stream(model, context, {
      apiKey: "gemini-key",
      fetch: test.fetch,
      onPayload: (value) => {
        const params = object.parse(value)
        expect(params.model).toBe(model.id)
        expect(object.parse(params.config).systemInstruction).toBe("Be concise")
        return { ...params, config: { ...object.parse(params.config), maxOutputTokens: 32 } }
      },
      onProviderStreamEvent: (event) => {
        raw.push(event)
      },
    })
    for await (const event of stream) events.push(event.type)
    const result = await stream.result()
    expect(test.order).toEqual(["authorize", "generate", "settle"])
    expect(result.stopReason).toBe("stop")
    expect(result.responseId).toBe("response-1")
    expect(result.content).toEqual([
      { type: "thinking", thinking: "Think", thinkingSignature: "dGhvdWdodC1zaWduYXR1cmU=" },
      { type: "text", text: "Hello", textSignature: "dGV4dC1zaWduYXR1cmU=" },
    ])
    expect(result.usage).toMatchObject({
      input: 80,
      output: 5,
      cacheRead: 20,
      reasoning: 2,
      totalTokens: 105,
    })
    expect(test.amounts[1]).toBeCloseTo(0.000092, 12)
    expect(raw).toHaveLength(2)
    expect(events).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ])
    const request = test.requests[0]
    expect(request?.url).toBe(
      "https://provider.test/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    )
    expect(request?.headers.get("x-goog-api-key")).toBe("gemini-key")
    expect(await request?.json()).toMatchObject({
      serviceTier: "standard",
      systemInstruction: { parts: [{ text: "Be concise" }] },
      generationConfig: { maxOutputTokens: 32, candidateCount: 1, responseModalities: ["TEXT"] },
    })
  })

  it("replays local functions and thought signatures through Pi's public converters", async () => {
    const test = fixture([
      () =>
        sse([
          {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { id: "call-1", name: "weather", args: { city: "Paris" } },
                      thoughtSignature: "dG9vbC1zaWduYXR1cmU=",
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: usage,
          },
        ]),
      () => sse([complete]),
    ])
    const toolContext = normalizeContext({
      messages: context.messages,
      tools: [
        {
          name: "weather",
          description: "Read weather",
          parameters: Type.Object({ city: Type.String() }),
        },
      ],
    })
    const first = await test.provider
      .streamSimple(model, toolContext, { apiKey: "key", fetch: test.fetch, reasoning: "low" })
      .result()
    expect(first.stopReason).toBe("toolUse")
    expect(first.content).toEqual([
      {
        type: "toolCall",
        id: "call-1",
        name: "weather",
        arguments: { city: "Paris" },
        thoughtSignature: "dG9vbC1zaWduYXR1cmU=",
      },
    ])
    const replay = normalizeContext({
      messages: [
        ...toolContext.messages,
        first,
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "weather",
          content: [{ type: "text", text: "Sunny" }],
          isError: false,
          timestamp: 2,
        },
      ],
    })
    const second = await test.provider
      .stream(model, replay, { apiKey: "key", fetch: test.fetch })
      .result()
    expect(second.stopReason).toBe("stop")
    const sent = object.parse(await test.requests[1]?.json())
    expect(sent.contents).toContainEqual({
      role: "model",
      parts: [
        {
          functionCall: { name: "weather", args: { city: "Paris" } },
          thoughtSignature: "dG9vbC1zaWduYXR1cmU=",
        },
      ],
    })
    expect(sent.contents).toContainEqual({
      role: "user",
      parts: [{ functionResponse: { name: "weather", response: { output: "Sunny" } } }],
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

  it("resolves native provider auth and preserves configured endpoint and header overrides", async () => {
    const test = fixture([() => sse([complete])])
    const models = createModels({
      authContext: {
        env: async (name) => (name === "GEMINI_API_KEY" ? "key-from-env" : undefined),
        fileExists: async () => false,
      },
    })
    const configuredModel = {
      ...model,
      baseUrl: "https://proxy.test/google/v1beta",
      headers: { "x-provider": "default", "x-order": "provider" },
    }
    models.setProvider({ ...test.provider, getModels: () => [configuredModel] })
    const responses: number[] = []
    const result = await models
      .streamSimple(configuredModel, context, {
        fetch: test.fetch,
        headers: { "x-order": "call" },
        onResponse: (response) => {
          responses.push(response.status)
        },
      })
      .result()
    expect(result.stopReason).toBe("stop")
    expect(test.order).toEqual(["authorize", "generate", "settle"])
    expect(test.requests[0]?.url).toBe(
      "https://proxy.test/google/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    )
    expect(test.requests[0]?.headers.get("x-goog-api-key")).toBe("key-from-env")
    expect(test.requests[0]?.headers.get("x-provider")).toBe("default")
    expect(test.requests[0]?.headers.get("x-order")).toBe("call")
    expect(responses).toEqual([200])
  })

  it("fails before authorization when a native payload hook enables hosted tools", async () => {
    const test = fixture([])
    const result = await test.provider
      .stream(model, context, {
        apiKey: "key",
        fetch: test.fetch,
        onPayload: (value) => {
          const params = object.parse(value)
          return {
            ...params,
            config: { ...object.parse(params.config), tools: [{ googleSearch: {} }] },
          }
        },
      })
      .result()
    expect(result.stopReason).toBe("error")
    expect(test.order).toEqual([])
  })

  it.each([
    () => sse([{ usageMetadata: usage }]),
    () =>
      new Response(`data: ${JSON.stringify({ usageMetadata: usage })}\n\ndata: invalid\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
    () =>
      sse([
        {
          candidates: [
            {
              content: { parts: [{ inlineData: { mimeType: "image/png", data: "image" } }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: usage,
        },
      ]),
    () =>
      sse([
        {
          candidates: [{ finishReason: "CONTINUATION", continuationToken: "token" }],
          usageMetadata: usage,
        },
      ]),
    () => new Response("Busy", { status: 503 }),
  ])(
    "consumes the full hold on incomplete, malformed, unsupported, or failed responses",
    async (reply) => {
      const test = fixture([reply])
      const result = await test.provider
        .stream(model, context, { apiKey: "key", fetch: test.fetch, maxRetries: 5 })
        .result()
      expect(result.stopReason).toBe("error")
      expect(test.order).toEqual(["authorize", "generate", "settle"])
      expect(test.amounts[1]).toBe(test.amounts[0])
    }
  )

  it.each(["missing", "terminal", "trailing"] as const)(
    "settles only final usage when it is %s after earlier partial counters",
    async (placement) => {
      const partial = {
        candidates: [{ content: { parts: [{ text: "First" }] } }],
        usageMetadata: usage,
      }
      const more = { candidates: [{ content: { parts: [{ text: " and more" }] } }] }
      const finalUsage = { ...usage, candidatesTokenCount: 13, totalTokenCount: 115 }
      const finish = {
        candidates: [{ finishReason: "STOP" }],
        ...(placement === "terminal" ? { usageMetadata: finalUsage } : {}),
      }
      const events = [
        partial,
        more,
        finish,
        ...(placement === "trailing" ? [{ usageMetadata: finalUsage }] : []),
      ]
      const test = fixture([() => sse(events)])
      const result = await test.provider
        .stream(model, context, { apiKey: "key", fetch: test.fetch })
        .result()
      expect(result.stopReason).toBe("stop")
      expect(result.content).toEqual([{ type: "text", text: "First and more" }])
      expect(test.order).toEqual(["authorize", "generate", "settle"])
      if (placement === "missing") {
        expect(result.usage.totalTokens).toBe(0)
        expect(test.amounts[1]).toBe(test.amounts[0])
      } else {
        expect(result.usage.totalTokens).toBe(115)
        expect(test.amounts[1]).toBeCloseTo(0.000112, 12)
      }
    }
  )

  it("rejects content after a terminal candidate and consumes the full hold", async () => {
    const test = fixture([
      () =>
        sse([
          complete,
          { candidates: [{ content: { parts: [{ text: "Unexpected continuation" }] } }] },
        ]),
    ])
    const result = await test.provider
      .stream(model, context, { apiKey: "key", fetch: test.fetch })
      .result()
    expect(result.stopReason).toBe("error")
    expect(test.amounts[1]).toBe(test.amounts[0])
  })

  it("aborts during a provider event and consumes the full hold", async () => {
    const test = fixture([() => sse([{ usageMetadata: usage }, complete])])
    const controller = new AbortController()
    const result = await test.provider
      .stream(model, context, {
        apiKey: "key",
        fetch: test.fetch,
        signal: controller.signal,
        onProviderStreamEvent: () => controller.abort(),
      })
      .result()
    expect(result.stopReason).toBe("aborted")
    expect(test.amounts[1]).toBe(test.amounts[0])
  })
})
