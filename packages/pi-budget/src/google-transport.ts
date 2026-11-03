import type {
  AssistantMessage,
  SimpleStreamOptions,
  StreamFunction,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai"
import type { GoogleOptions } from "@earendil-works/pi-ai/api/google-generative-ai"
import {
  convertMessages,
  convertTools,
  getDisabledGoogleThinkingConfig,
  isThinkingPart,
  mapStopReasonString,
  resolveGoogleFunctionCallingMode,
  resolveGoogleThinkingLevel,
  retainThoughtSignature,
  supportsGoogleStrictToolSampling,
  toGoogleThinkingLevel,
  usesGoogleThinkingLevel,
} from "@earendil-works/pi-ai/api/google-shared"
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options"
import { calculateCost, clampThinkingLevel } from "@earendil-works/pi-ai/models"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import { providerHeadersToRecord } from "@earendil-works/pi-ai/utils/headers"
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode"
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text"
import {
  collapseSystemMessages,
  getCurrentTools,
  getInitialSystemMessage,
} from "@earendil-works/pi-ai/utils/transcript"
import { z } from "zod"

const object = z.record(z.string(), z.unknown())
const json: z.ZodType<ToolCall["arguments"][string]> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(json),
    z.record(z.string(), json),
  ])
)
const token = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const partSchema = z
  .object({
    text: z.string().optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().optional(),
    functionCall: z
      .object({
        id: z.string().optional(),
        name: z.string().min(1),
        args: z.record(z.string(), json).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((part) => !(part.text !== undefined && part.functionCall !== undefined))
const chunkSchema = z.object({
  responseId: z.string().optional(),
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(partSchema).optional() }).optional(),
        finishReason: z.string().optional(),
        continuationToken: z.never().optional(),
      })
    )
    .max(1)
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: token.optional(),
      cachedContentTokenCount: token.optional(),
      candidatesTokenCount: token.optional(),
      thoughtsTokenCount: token.optional(),
      totalTokenCount: token.optional(),
      toolUsePromptTokenCount: z.literal(0).optional(),
    })
    .optional(),
  error: z.never().optional(),
})
const paramsSchema = z
  .object({ model: z.string(), contents: z.array(z.unknown()), config: object.optional() })
  .strict()

async function* readEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let line = ""
  let data: string[] = []
  let afterCR = false
  const onAbort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await reader.read()
      signal.throwIfAborted()
      const text = next.done ? decoder.decode() : decoder.decode(next.value, { stream: true })
      for (const char of text) {
        if (afterCR && char === "\n") {
          afterCR = false
          continue
        }
        afterCR = char === "\r"
        if (char !== "\r" && char !== "\n") {
          line += char
          continue
        }
        if (line === "") {
          if (data.length > 0) {
            const value = data.join("\n")
            data = []
            if (value !== "[DONE]") yield JSON.parse(value) as unknown
          }
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
        line = ""
      }
      if (next.done) break
    }
    if (line || data.length) throw new Error("Incomplete Gemini stream event")
  } finally {
    signal.removeEventListener("abort", onAbort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Pi 1.3 rejects custom Google fetch. Reuse its public codecs with an explicit HTTP transport. */
export const streamGoogle: StreamFunction<"google-generative-ai", GoogleOptions> = (
  model,
  context,
  options = {}
) => {
  const stream = new AssistantMessageEventStream()
  const output: AssistantMessage = {
    role: "assistant",
    api: "google-generative-ai",
    provider: model.provider,
    model: model.id,
    content: [],
    stopReason: "pending",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
  const run = async () => {
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 120000)
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
    let current: { block: TextContent | ThinkingContent; index: number } | undefined
    let responseBody: ReadableStream<Uint8Array> | null = null
    const finishBlock = () => {
      if (!current) return
      const { block, index } = current
      if (block.type === "text")
        stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output })
      else
        stream.push({
          type: "thinking_end",
          contentIndex: index,
          content: block.thinking,
          partial: output,
        })
      current = undefined
    }
    try {
      signal.throwIfAborted()
      if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`)
      if (!options.fetch) throw new Error("Budgeted Gemini requires an explicit fetch transport")
      const transcript = collapseSystemMessages(context)
      const system = getInitialSystemMessage(transcript.messages)
      const tools = getCurrentTools(transcript.messages)
      const strict = supportsGoogleStrictToolSampling(model.id)
      const toolMode = tools.length
        ? resolveGoogleFunctionCallingMode(tools, options.toolChoice, strict)
        : undefined
      const config: Record<string, unknown> = {
        ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(system ? { systemInstruction: sanitizeSurrogates(getSystemMessageText(system)) } : {}),
        ...(tools.length ? { tools: convertTools(tools, false, strict) } : {}),
        ...(toolMode !== undefined
          ? { toolConfig: { functionCallingConfig: { mode: toolMode } } }
          : {}),
        abortSignal: signal,
      }
      if (model.reasoning && options.thinking) {
        config.thinkingConfig = options.thinking.enabled
          ? {
              includeThoughts: true,
              ...(options.thinking.level !== undefined
                ? { thinkingLevel: options.thinking.level }
                : options.thinking.budgetTokens !== undefined
                  ? { thinkingBudget: options.thinking.budgetTokens }
                  : {}),
            }
          : getDisabledGoogleThinkingConfig(model)
      }
      const original = { model: model.id, contents: convertMessages(model, transcript), config }
      const params = paramsSchema.parse((await options.onPayload?.(original, model)) ?? original)
      if (params.model !== model.id) throw new Error("Budgeted model cannot change")
      const {
        systemInstruction,
        tools: finalTools,
        toolConfig,
        safetySettings,
        serviceTier,
        store,
        cachedContent,
        abortSignal: _abortSignal,
        ...generationConfig
      } = params.config ?? {}
      const instruction =
        typeof systemInstruction === "string"
          ? { parts: [{ text: systemInstruction }] }
          : systemInstruction
      const payload = {
        contents: params.contents,
        generationConfig,
        ...(instruction !== undefined ? { systemInstruction: instruction } : {}),
        ...(finalTools !== undefined ? { tools: finalTools } : {}),
        ...(toolConfig !== undefined ? { toolConfig } : {}),
        ...(safetySettings !== undefined ? { safetySettings } : {}),
        ...(serviceTier !== undefined ? { serviceTier } : {}),
        ...(store !== undefined ? { store } : {}),
        ...(cachedContent !== undefined ? { cachedContent } : {}),
      }
      const url = new URL(
        `${model.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model.id.replace(/^models\//, ""))}:streamGenerateContent`
      )
      url.searchParams.set("alt", "sse")
      const headers = new Headers(providerHeadersToRecord(model.headers, options.headers))
      headers.set("content-type", "application/json")
      headers.set("x-goog-api-key", options.apiKey)
      const response = await options.fetch(
        new Request(url, { method: "POST", headers, body: JSON.stringify(payload), signal })
      )
      responseBody = response.body
      await options.onResponse?.(
        { status: response.status, headers: Object.fromEntries(response.headers) },
        model
      )
      if (!response.ok) throw new Error(`Gemini request failed with HTTP ${response.status}`)
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
        throw new Error("Gemini did not return an SSE stream")
      stream.push({ type: "start", partial: output })
      for await (const raw of readEvents(response.body, signal)) {
        signal.throwIfAborted()
        const chunk = chunkSchema.parse(raw)
        await options.onProviderStreamEvent?.(raw, model)
        signal.throwIfAborted()
        if (!output.responseId && chunk.responseId) output.responseId = chunk.responseId
        const candidate = chunk.candidates?.[0]
        if (
          output.rawStopReason !== undefined &&
          ((candidate?.content?.parts?.length ?? 0) > 0 ||
            (candidate?.finishReason !== undefined &&
              candidate.finishReason !== output.rawStopReason))
        )
          throw new Error("Gemini returned content or a changed finish reason after completion")
        for (const part of candidate?.content?.parts ?? []) {
          if (part.text !== undefined || (!part.functionCall && part.thoughtSignature)) {
            const thinking =
              part.text === undefined && current
                ? current.block.type === "thinking"
                : isThinkingPart({ thought: part.thought ?? false })
            const kind = thinking ? "thinking" : "text"
            const previousSignature =
              current?.block.type === "text"
                ? current.block.textSignature
                : current?.block.thinkingSignature
            if (
              !current ||
              current.block.type !== kind ||
              (part.thoughtSignature &&
                previousSignature &&
                part.thoughtSignature !== previousSignature)
            ) {
              finishBlock()
              const block: TextContent | ThinkingContent = thinking
                ? { type: "thinking", thinking: "" }
                : { type: "text", text: "" }
              current = { block, index: output.content.length }
              output.content.push(block)
              if (block.type === "thinking")
                stream.push({
                  type: "thinking_start",
                  contentIndex: current.index,
                  partial: output,
                })
              else stream.push({ type: "text_start", contentIndex: current.index, partial: output })
            }
            const text = part.text ?? ""
            if (current.block.type === "thinking") {
              current.block.thinking += text
              const signature = retainThoughtSignature(
                current.block.thinkingSignature,
                part.thoughtSignature
              )
              if (signature !== undefined) current.block.thinkingSignature = signature
              stream.push({
                type: "thinking_delta",
                contentIndex: current.index,
                delta: text,
                partial: output,
              })
            } else {
              current.block.text += text
              const signature = retainThoughtSignature(
                current.block.textSignature,
                part.thoughtSignature
              )
              if (signature !== undefined) current.block.textSignature = signature
              stream.push({
                type: "text_delta",
                contentIndex: current.index,
                delta: text,
                partial: output,
              })
            }
          }
          if (part.functionCall) {
            finishBlock()
            const provided = part.functionCall.id
            const id =
              provided &&
              !output.content.some((block) => block.type === "toolCall" && block.id === provided)
                ? provided
                : `${part.functionCall.name}_${crypto.randomUUID()}`
            const toolCall: ToolCall = {
              type: "toolCall",
              id,
              name: part.functionCall.name,
              arguments: part.functionCall.args ?? {},
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
            }
            const contentIndex = output.content.length
            output.content.push(toolCall)
            stream.push({ type: "toolcall_start", contentIndex, partial: output })
            stream.push({
              type: "toolcall_delta",
              contentIndex,
              delta: JSON.stringify(toolCall.arguments),
              partial: output,
            })
            stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output })
          }
        }
        if (candidate?.finishReason) {
          output.rawStopReason = candidate.finishReason
          output.stopReason = mapStopReasonString(candidate.finishReason)
          if (
            output.stopReason === "stop" &&
            output.content.some((block) => block.type === "toolCall")
          )
            output.stopReason = "toolUse"
        }
        const usage = chunk.usageMetadata
        if (
          output.rawStopReason !== undefined &&
          usage?.promptTokenCount !== undefined &&
          usage.totalTokenCount !== undefined
        ) {
          const cacheRead = usage.cachedContentTokenCount ?? 0
          if (
            cacheRead > usage.promptTokenCount ||
            usage.totalTokenCount !==
              usage.promptTokenCount +
                (usage.candidatesTokenCount ?? 0) +
                (usage.thoughtsTokenCount ?? 0)
          )
            throw new Error("Invalid Gemini usage")
          output.usage = {
            input: usage.promptTokenCount - cacheRead,
            output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
            cacheRead,
            cacheWrite: 0,
            reasoning: usage.thoughtsTokenCount ?? 0,
            totalTokens: usage.totalTokenCount,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          }
          calculateCost(model, output.usage)
        }
      }
      signal.throwIfAborted()
      finishBlock()
      if (
        output.stopReason === "pending" ||
        output.stopReason === "error" ||
        output.stopReason === "aborted"
      )
        throw new Error(`Gemini stream ended with ${output.rawStopReason ?? "no finish reason"}`)
      stream.push({ type: "done", reason: output.stopReason, message: output })
    } catch (error) {
      output.usage.totalTokens = 0
      output.stopReason = signal.aborted ? "aborted" : "error"
      output.errorMessage = error instanceof Error ? error.message : String(error)
      stream.push({ type: "error", reason: output.stopReason, error: output })
    } finally {
      if (responseBody && !responseBody.locked) await responseBody.cancel().catch(() => undefined)
      stream.end()
    }
  }
  void run()
  return stream
}

export const streamGoogleSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
  model,
  context,
  options = {}
) => {
  if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`)
  const base = {
    ...buildBaseOptions(model, context, options, options.apiKey),
    ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
  }
  const level = options.reasoning ? clampThinkingLevel(model, options.reasoning) : "off"
  if (level === "off")
    return streamGoogle(model, context, { ...base, thinking: { enabled: false } })
  const resolved = resolveGoogleThinkingLevel(model, level)
  if (usesGoogleThinkingLevel(model))
    return streamGoogle(model, context, {
      ...base,
      thinking: { enabled: true, level: toGoogleThinkingLevel(resolved) },
    })
  const defaults = model.id.includes("2.5-pro")
    ? { minimal: 128, low: 2048, medium: 8192, high: 32768 }
    : { minimal: model.id.includes("flash-lite") ? 512 : 128, low: 2048, medium: 8192, high: 24576 }
  return streamGoogle(model, context, {
    ...base,
    thinking: {
      enabled: true,
      budgetTokens: options.thinkingBudgets?.[resolved] ?? defaults[resolved],
    },
  })
}
