import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { BudgetSettleError, Unprice } from "@unprice/budgets"
import { inputBound } from "@unprice/budgets-ai"
import { generateText, jsonSchema, streamText, wrapLanguageModel } from "ai"
import { describe, expect, it, vi } from "vitest"
import { createUnpriceBudgetMiddleware } from "./index"

const pricing = { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 1 }
const limits = { context: 1_000_000, output: 4096 }
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const deferred = <T>() => Promise.withResolvers<T>()
const balance = { remaining: "1", held: "0", limits: [], asOf: 1_792_000_000_000 }
const completedResponse = {
  id: "resp_1",
  object: "response",
  created_at: 1_792_000_000,
  model: "gpt-test",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "answer", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: 14,
  },
}

function harness(
  options: {
    key?: string
    denied?: boolean
    settleGate?: Promise<void>
    failSettle?: boolean
    generationFailures?: number
    streamGate?: Promise<void>
    pricing?: typeof pricing
    background?: Promise<unknown>[]
  } = {}
) {
  const authorized: Array<{ amount: string; idempotencyKey: string; key: string }> = []
  const settled: Array<{ amount: string; holdId: string }> = []
  const requests: Request[] = []
  let generationCount = 0
  const unprice = new Unprice({
    token: "test",
    baseUrl: "https://budgets.test",
    disableTelemetry: true,
    retry: { attempts: 0 },
    fetch: async (request) => {
      const body: unknown = await request.json()
      if (request.url.endsWith("/authorize")) {
        const input = authorizationBody(body)
        authorized.push(input)
        if (options.denied) {
          return json(
            {
              error: {
                code: "BUDGET_EXCEEDED",
                message: "Denied",
                requestId: "req_denied",
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
        }
        return json({
          allowed: true,
          holdId: `h_${authorized.length}`,
          amount: input.amount,
          expiresAt: Date.now() + 300_000,
          replayed: false,
          balance,
        })
      }
      const input = settlementBody(body)
      settled.push(input)
      await options.settleGate
      if (options.failSettle) {
        return json(
          { error: { code: "CONFLICT", message: "Settle failed", requestId: "req_settle" } },
          409
        )
      }
      return json({
        ...input,
        actual: input.amount,
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
    budget: options.key ?? "customer:a",
    models: { "openai/gpt-test": { rates: options.pricing ?? pricing, tiers: [], limits } },
    maxOutputTokens: 16,
    ...(options.background
      ? {
          waitUntil: (work: Promise<unknown>) => {
            options.background?.push(work)
          },
        }
      : {}),
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request.clone())
      generationCount++
      if (generationCount <= (options.generationFailures ?? 0)) {
        return new Response(
          JSON.stringify({ error: { message: "Try again", type: "server_error" } }),
          {
            status: 503,
            headers: { "content-type": "application/json", "retry-after-ms": "0" },
          }
        )
      }
      const body: unknown = await request.json()
      if (typeof body === "object" && body !== null && "stream" in body && body.stream === true) {
        const encode = (value: unknown) =>
          new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encode({ type: "response.created", response: completedResponse }))
              controller.enqueue(
                encode({
                  type: "response.output_item.added",
                  output_index: 0,
                  item: completedResponse.output[0],
                })
              )
              controller.enqueue(
                encode({
                  type: "response.content_part.added",
                  item_id: "msg_1",
                  output_index: 0,
                  content_index: 0,
                  part: { type: "output_text", text: "", annotations: [] },
                })
              )
              controller.enqueue(
                encode({
                  type: "response.output_text.delta",
                  item_id: "msg_1",
                  output_index: 0,
                  content_index: 0,
                  delta: "answer",
                })
              )
              await options.streamGate
              controller.enqueue(
                encode({ type: "response.completed", response: completedResponse })
              )
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
      }
      return json(completedResponse)
    },
  })
  const provider = createOpenAI({ apiKey: "test", fetch: adapter.fetch })
  const model = wrapLanguageModel({
    model: provider.responses("gpt-test"),
    middleware: adapter.middleware,
  })
  return { adapter, model, authorized, settled, requests, generationCount: () => generationCount }
}

function authorizationBody(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("amount" in value) ||
    typeof value.amount !== "string" ||
    !("idempotencyKey" in value) ||
    typeof value.idempotencyKey !== "string" ||
    !("key" in value) ||
    typeof value.key !== "string"
  )
    throw new Error("Invalid authorization test request")
  return { amount: value.amount, idempotencyKey: value.idempotencyKey, key: value.key }
}

function settlementBody(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("amount" in value) ||
    typeof value.amount !== "string" ||
    !("holdId" in value) ||
    typeof value.holdId !== "string"
  )
    throw new Error("Invalid settlement test request")
  return { amount: value.amount, holdId: value.holdId }
}

/**
 * The hold the harness's 16-token cap requires for the body the provider received: its byte bound
 * at the highest input rate (input and cacheWrite, 1) plus 16 output tokens at 4, rounded up at
 * eight decimals and formatted as the API carries amounts. Stated here on its own so the test does
 * not borrow the adapter's arithmetic.
 */
async function fullHold(h: ReturnType<typeof harness>, index = 0): Promise<string> {
  const request = h.requests[index]
  if (!request) throw new Error("Missing provider request")
  const body = await request.clone().text()
  const { input, instructions } = JSON.parse(body) as { input: unknown; instructions?: string }
  const items = typeof input === "string" ? 1 : (input as unknown[]).length
  const messages = items + (instructions === undefined ? 0 : 1)
  const cost = (inputBound(body, messages) * 1 + 16 * 4) / 1_000_000
  return (Math.ceil(cost * 100_000_000) / 100_000_000).toFixed(8).replace(/\.?0+$/, "")
}

const generate = (model: LanguageModelV4) =>
  generateText({ model, prompt: "hello", maxOutputTokens: 16, maxRetries: 0 })

function replaceProviderStream(
  h: ReturnType<typeof harness>,
  stream: ReadableStream<LanguageModelV4StreamPart>,
  onParams?: (params: { headers?: Record<string, string | undefined> }) => void
) {
  return wrapLanguageModel({
    model: createOpenAI({ apiKey: "test", fetch: h.adapter.fetch }).responses("gpt-test"),
    middleware: [
      h.adapter.middleware,
      {
        wrapStream: async ({ doStream, params }) => {
          onParams?.(params)
          const result = await doStream()
          await result.stream.cancel()
          return { ...result, stream }
        },
      },
    ],
  })
}

async function readAll(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const parts: LanguageModelV4StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return parts
    parts.push(value)
  }
}

describe("AI SDK budget middleware", () => {
  it("does not read an unconsumed stream or accumulate output", async () => {
    const controller = new AbortController()
    const background: Promise<unknown>[] = []
    const h = harness({ background })
    let pulls = 0
    let cancellations = 0
    let token: string | undefined
    const source = new ReadableStream<LanguageModelV4StreamPart>(
      {
        pull(output) {
          pulls++
          if (pulls <= 100) output.enqueue({ type: "text-delta", id: "text", delta: "x" })
          else output.close()
        },
        cancel() {
          cancellations++
        },
      },
      { highWaterMark: 0 }
    )
    const model = replaceProviderStream(h, source, (params) => {
      token = params.headers?.["x-unprice-budget-call"]
    })
    const result = await model.doStream({ prompt: [], abortSignal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pulls).toBe(0)
    const reader = result.stream.getReader()
    await expect(reader.read()).resolves.toMatchObject({ value: { type: "text-delta" } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pulls).toBe(1)
    controller.abort(new Error("abandoned"))
    await Promise.all(background)
    expect(h.settled[0]?.amount).toBe(await fullHold(h))
    expect(cancellations).toBe(1)
    expect(background).toHaveLength(1)
    if (!token) throw new Error("Missing test call token")
    await expect(
      h.adapter.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "x-unprice-budget-call": token },
        body: "{}",
      })
    ).rejects.toThrow("matching Unprice budget middleware")
  })

  it("settles before a provider error is visible and stops reading", async () => {
    const settleGate = deferred<void>()
    const h = harness({ settleGate: settleGate.promise })
    let pulls = 0
    let cancellations = 0
    const providerError = new Error("provider stream failed")
    const source = new ReadableStream<LanguageModelV4StreamPart>(
      {
        pull(output) {
          pulls++
          if (pulls === 1) output.enqueue({ type: "error", error: providerError })
          else return new Promise<void>(() => undefined)
        },
        cancel() {
          cancellations++
        },
      },
      { highWaterMark: 0 }
    )
    const model = replaceProviderStream(h, source)
    const result = await model.doStream({ prompt: [] })
    const reader = result.stream.getReader()
    let visible = false
    const reading = reader.read().then((part) => {
      visible = true
      return part
    })
    await vi.waitFor(() => expect(h.settled).toHaveLength(1))
    expect(visible).toBe(false)
    expect(pulls).toBe(1)
    settleGate.resolve()
    await expect(reading).resolves.toMatchObject({ value: { type: "error", error: providerError } })
    await expect(reader.read()).resolves.toMatchObject({ done: true })
    expect(cancellations).toBe(1)
    expect(pulls).toBe(1)
  })

  it("blocks later tool execution when a provider error settlement fails", async () => {
    const h = harness({ failSettle: true })
    let pulls = 0
    const execute = vi.fn(async () => "unexpected execution")
    const source = new ReadableStream<LanguageModelV4StreamPart>(
      {
        pull(output) {
          pulls++
          if (pulls === 1) output.enqueue({ type: "error", error: new Error("provider failed") })
          else
            output.enqueue({
              type: "tool-call",
              toolCallId: "tool_1",
              toolName: "danger",
              input: "{}",
            })
        },
      },
      { highWaterMark: 0 }
    )
    const model = replaceProviderStream(h, source)
    const result = streamText({
      model,
      prompt: "hello",
      maxRetries: 0,
      tools: { danger: { inputSchema: jsonSchema({ type: "object" }), execute } },
      onError: () => undefined,
    })
    const chunks: string[] = []
    let successfulFinish = false
    const reading = (async () => {
      for await (const part of result.fullStream) {
        chunks.push(part.type)
        if (part.type === "finish" && part.finishReason !== "error") successfulFinish = true
      }
    })()
    await expect(reading).rejects.toMatchObject({ name: "BudgetSettleError" })
    expect(chunks).not.toContain("tool-call")
    expect(successfulFinish).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect(pulls).toBe(1)
    expect(h.settled).toHaveLength(1)
  })

  it("cleans a cancelled backpressured stream and reports settlement failure", async () => {
    const background: Promise<unknown>[] = []
    const h = harness({ background, failSettle: true })
    let cancellations = 0
    const source = new ReadableStream<LanguageModelV4StreamPart>(
      {
        cancel() {
          cancellations++
        },
      },
      { highWaterMark: 0 }
    )
    const model = replaceProviderStream(h, source)
    const result = await model.doStream({ prompt: [] })
    await expect(result.stream.cancel()).rejects.toMatchObject({ name: "BudgetSettleError" })
    await Promise.all(background)
    expect(cancellations).toBe(1)
    expect(h.settled).toHaveLength(1)
  })
  it("blocks generation when authorization is denied", async () => {
    const h = harness({ denied: true })
    await expect(generate(h.model)).rejects.toMatchObject({ name: "BudgetExceededError" })
    expect(h.generationCount()).toBe(0)
    expect(h.settled).toEqual([])
  })

  it("uses final serialized JSON and removes the internal header", async () => {
    const h = harness()
    const result = await generate(h.model)
    expect(result.text).toBe("answer")
    expect(h.authorized[0]?.amount).toBe(await fullHold(h))
    expect(h.settled).toEqual([{ holdId: "h_1", amount: "0.000025" }])
    expect(h.requests).toHaveLength(1)
    for (const request of h.requests) {
      expect(request.headers.has("x-unprice-budget-call")).toBe(false)
    }
    const generation: unknown = await h.requests[0]?.json()
    expect(generation).toMatchObject({
      model: "gpt-test",
      max_output_tokens: 16,
      service_tier: "default",
    })
    expect(generation).not.toMatchObject({ stream: true })
  })

  it("holds generation completion until settlement succeeds", async () => {
    const gate = deferred<void>()
    const h = harness({ settleGate: gate.promise })
    let finished = false
    const result = generate(h.model).then(() => {
      finished = true
    })
    await vi.waitFor(() => expect(h.settled).toHaveLength(1))
    expect(finished).toBe(false)
    gate.resolve()
    await result
    expect(finished).toBe(true)
  })

  it("streams text and holds finish until settlement succeeds", async () => {
    const gate = deferred<void>()
    const h = harness({ settleGate: gate.promise })
    const result = streamText({ model: h.model, prompt: "hello", maxRetries: 0 })
    const parts: string[] = []
    const reading = (async () => {
      for await (const part of result.fullStream) parts.push(part.type)
    })()
    await vi.waitFor(() => expect(h.settled).toHaveLength(1))
    expect(parts).toContain("text-delta")
    expect(parts).not.toContain("finish")
    gate.resolve()
    await reading
    expect(parts).toContain("finish")
    expect(h.settled[0]?.amount).toBe("0.000025")
  })

  it("settles an abandoned stream on abort without a consumer", async () => {
    const controller = new AbortController()
    const background: Promise<unknown>[] = []
    const h = harness({ background })
    await h.model.doStream({ prompt: [], abortSignal: controller.signal })
    expect(h.settled).toEqual([])
    controller.abort(new Error("abandoned"))
    await Promise.all(background)
    expect(h.settled[0]?.amount).toBe(await fullHold(h))
  })

  it("keeps waitUntil pending through the complete stream lifetime", async () => {
    const gate = deferred<void>()
    const background: Promise<unknown>[] = []
    const h = harness({ background, streamGate: gate.promise })
    const result = await h.model.doStream({ prompt: [] })
    const reading = readAll(result.stream)
    expect(background).toHaveLength(1)
    let complete = false
    void background[0]?.then(() => {
      complete = true
    })
    await Promise.resolve()
    expect(complete).toBe(false)
    gate.resolve()
    await reading
    await Promise.all(background)
    expect(h.settled[0]?.amount).toBe("0.000025")
    expect(complete).toBe(true)
  })

  it("settles the full hold after cancellation", async () => {
    const gate = deferred<void>()
    const h = harness({ streamGate: gate.promise })
    const result = await h.model.doStream({ prompt: [] })
    await result.stream.cancel("caller disconnected")
    expect(h.settled[0]?.amount).toBe(await fullHold(h))
    gate.resolve()
  })

  it("settles the full hold when the caller aborts", async () => {
    const gate = deferred<void>()
    const controller = new AbortController()
    const h = harness({ streamGate: gate.promise })
    const result = await h.model.doStream({ prompt: [], abortSignal: controller.signal })
    controller.abort(new Error("caller aborted"))
    await vi.waitFor(() => expect(h.settled).toHaveLength(1))
    await expect(result.stream.getReader().read()).rejects.toThrow("caller aborted")
    expect(h.settled[0]?.amount).toBe(await fullHold(h))
    gate.resolve()
  })

  it("uses the same pricing snapshot for the hold and settlement", async () => {
    const gate = deferred<void>()
    const rates = { ...pricing }
    const h = harness({ streamGate: gate.promise, pricing: rates })
    const result = await h.model.doStream({ prompt: [] })
    rates.input = 100
    rates.output = 100
    rates.cacheRead = 100
    gate.resolve()
    await readAll(result.stream)
    expect(h.settled[0]?.amount).toBe("0.000025")
  })

  it("settles the full hold when normalized usage is absent", async () => {
    const h = harness()
    const unknown = wrapLanguageModel({
      model: createOpenAI({ apiKey: "test", fetch: h.adapter.fetch }).responses("gpt-test"),
      middleware: [
        h.adapter.middleware,
        {
          wrapGenerate: async ({ doGenerate }) => ({
            ...(await doGenerate()),
            usage: {
              inputTokens: {
                total: undefined,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: undefined, text: undefined, reasoning: undefined },
            },
          }),
        },
      ],
    })
    await generate(unknown)
    expect(h.settled[0]?.amount).toBe(await fullHold(h))
  })

  it("keeps parallel calls and budget keys separate", async () => {
    const a = harness({ key: "customer:a" })
    const b = harness({ key: "customer:b" })
    await Promise.all([generate(a.model), generate(a.model), generate(b.model)])
    expect(a.authorized.map((item) => item.key)).toEqual(["customer:a", "customer:a"])
    expect(b.authorized.map((item) => item.key)).toEqual(["customer:b"])
    expect(new Set(a.authorized.map((item) => item.idempotencyKey)).size).toBe(2)
    expect(a.settled.map((item) => item.holdId).sort()).toEqual(["h_1", "h_2"])
  })

  it("authorizes SDK retry attempts separately", async () => {
    const h = harness({ generationFailures: 1 })
    const result = await generateText({ model: h.model, prompt: "hello", maxRetries: 1 })
    expect(result.text).toBe("answer")
    expect(h.generationCount()).toBe(2)
    expect(h.authorized).toHaveLength(2)
    expect(h.authorized[0]?.idempotencyKey).not.toBe(h.authorized[1]?.idempotencyKey)
    expect(h.settled).toEqual([
      { holdId: "h_1", amount: await fullHold(h, 0) },
      { holdId: "h_2", amount: "0.000025" },
    ])
  })

  it("propagates a settlement failure and never reports success", async () => {
    const h = harness({ failSettle: true })
    const error: unknown = await generate(h.model).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(BudgetSettleError)
    if (!(error instanceof BudgetSettleError)) throw new Error("Expected settlement failure")
    expect(error.value).toMatchObject({
      content: [{ type: "text", text: "answer" }],
      usage: { inputTokens: { total: 10 }, outputTokens: { total: 4 } },
      providerMetadata: { openai: { responseId: "resp_1" } },
    })
    expect(error.actual).toBe(0.000025)
    expect(error.hold.id).toBe("h_1")
    expect(error.idempotencyKey).toBe(h.authorized[0]?.idempotencyKey)
    expect(error.recovery).toEqual({ amount: "0.000025" })
    expect(typeof error.retry).toBe("function")
    expect(h.generationCount()).toBe(1)
    expect(h.settled).toHaveLength(1)
  })

  it("fails the stream before finish when settlement fails", async () => {
    const h = harness({ failSettle: true })
    const result = await h.model.doStream({ prompt: [] })
    const parts: string[] = []
    const reading = (async () => {
      const reader = result.stream.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        parts.push(value.type)
      }
    })()
    await expect(reading).rejects.toMatchObject({ name: "BudgetSettleError" })
    expect(parts).not.toContain("finish")
    expect(h.settled).toHaveLength(1)
  })

  it("settles full usage when a stream ends without finish", async () => {
    const h = harness()
    const incomplete = wrapLanguageModel({
      model: createOpenAI({ apiKey: "test", fetch: h.adapter.fetch }).responses("gpt-test"),
      middleware: [
        h.adapter.middleware,
        {
          wrapStream: async ({ doStream }) => {
            const result = await doStream()
            return {
              ...result,
              stream: result.stream.pipeThrough(
                new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
                  transform(part, controller) {
                    if (part.type !== "finish") controller.enqueue(part)
                  },
                })
              ),
            }
          },
        },
      ],
    })
    const result = await incomplete.doStream({ prompt: [] })
    const reading = (async () => {
      const reader = result.stream.getReader()
      while (!(await reader.read()).done) {}
    })()
    await expect(reading).rejects.toThrow("without final usage")
    expect(h.settled[0]?.amount).toBe(await fullHold(h))
  })

  it("settles measured usage for an error finish", async () => {
    const h = harness()
    const errored = wrapLanguageModel({
      model: createOpenAI({ apiKey: "test", fetch: h.adapter.fetch }).responses("gpt-test"),
      middleware: [
        h.adapter.middleware,
        {
          wrapStream: async ({ doStream }) => {
            const result = await doStream()
            return {
              ...result,
              stream: result.stream.pipeThrough(
                new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
                  transform(part, controller) {
                    controller.enqueue(
                      part.type === "finish"
                        ? { ...part, finishReason: { unified: "error", raw: "error" } }
                        : part
                    )
                  },
                })
              ),
            }
          },
        },
      ],
    })
    const result = await errored.doStream({ prompt: [] })
    const reader = result.stream.getReader()
    let finishReason: string | undefined
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.type === "finish") finishReason = value.finishReason.unified
    }
    expect(finishReason).toBe("error")
    expect(h.settled[0]?.amount).toBe("0.000025")
  })

  it("blocks a duplicate dispatch inside one middleware call", async () => {
    const h = harness()
    const duplicate = wrapLanguageModel({
      model: createOpenAI({ apiKey: "test", fetch: h.adapter.fetch }).responses("gpt-test"),
      middleware: [
        h.adapter.middleware,
        {
          wrapGenerate: async ({ doGenerate }) => {
            const first = await doGenerate()
            await doGenerate()
            return first
          },
        },
      ],
    })
    await expect(generate(duplicate)).rejects.toThrow("one generation request")
    expect(h.generationCount()).toBe(1)
    expect(h.authorized).toHaveLength(1)
  })

  it("blocks a provider configured with another middleware's fetch", async () => {
    const a = harness()
    const b = harness()
    const mismatch = wrapLanguageModel({
      model: createOpenAI({ apiKey: "test", fetch: a.adapter.fetch }).responses("gpt-test"),
      middleware: b.adapter.middleware,
    })
    await expect(generate(mismatch)).rejects.toThrow("matching Unprice budget middleware")
    expect(a.requests).toEqual([])
    expect(b.requests).toEqual([])
  })

  it("preserves provider response metadata", async () => {
    const h = harness()
    const result = await generate(h.model)
    expect(result.providerMetadata).toMatchObject({ openai: { responseId: "resp_1" } })
    expect(result.response).toMatchObject({ id: "resp_1", modelId: "gpt-test" })
  })

  it("blocks fetch calls without matching middleware", async () => {
    const h = harness()
    await expect(
      h.adapter.fetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })
    ).rejects.toThrow("matching Unprice budget middleware")
    expect(h.requests).toEqual([])
  })
})
