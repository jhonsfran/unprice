import type { Api, AssistantMessage, Model, StreamOptions } from "@earendil-works/pi-ai"
import type { GoogleOptions } from "@earendil-works/pi-ai/api/google-generative-ai"
import { type Provider, hasApi } from "@earendil-works/pi-ai/models"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import { BudgetExceededError, type BudgetHandle } from "@unprice/budgets"
import {
  type BudgetProtocol,
  type BudgetSession,
  createBudgetSession,
  createStreamUsageEvidence,
  prepareOpenAIResponsesRequest,
} from "@unprice/budgets-ai"

import { streamGoogle, streamGoogleSimple } from "./google-transport"

export interface UnpriceBudgetOptions {
  getBudget: () => BudgetHandle | Promise<BudgetHandle>
  waitUntil?: (promise: Promise<unknown>) => void
  maxOutputTokens?: number
  budgetTimeoutMs?: number
}

function budgetProtocol(api: Api): BudgetProtocol {
  switch (api) {
    case "openai-responses":
      return "openai-responses"
    case "anthropic-messages":
      return "anthropic-messages"
    case "google-generative-ai":
      return "google-generative-ai"
    default:
      throw new Error("Unsupported budgeted model API")
  }
}

function failedMessage(
  model: Model<Api>,
  error: unknown
): AssistantMessage & { errorMessage: string } {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    stopReason: "error",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    errorMessage:
      error instanceof BudgetExceededError
        ? "The budget cannot cover this call."
        : "The budget check or settlement failed. This model call was blocked.",
  }
}

function measuredCost(message: AssistantMessage): number | undefined {
  const { usage } = message
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(
    (count) => Number.isSafeInteger(count) && count >= 0
  ) &&
    usage.totalTokens > 0 &&
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 &&
    Number.isFinite(usage.cost.total) &&
    usage.cost.total >= 0
    ? usage.cost.total
    : undefined
}

/** Wrap Pi chat dispatch methods with shared request authorization and settlement. */
export function withUnpriceBudget(provider: Provider, config: UnpriceBudgetOptions): Provider {
  const outputCap = config.maxOutputTokens ?? 4096
  if (!Number.isSafeInteger(outputCap) || outputCap < 16)
    throw new Error("maxOutputTokens must be a safe integer of at least 16")
  if (
    config.budgetTimeoutMs !== undefined &&
    (!Number.isSafeInteger(config.budgetTimeoutMs) ||
      config.budgetTimeoutMs <= 0 ||
      config.budgetTimeoutMs > 2_147_483_647)
  )
    throw new Error("budgetTimeoutMs must be a positive 32-bit integer")
  type Bounded = Pick<
    StreamOptions,
    | "maxTokens"
    | "maxRetries"
    | "timeoutMs"
    | "signal"
    | "fetch"
    | "onPayload"
    | "onProviderStreamEvent"
  > & { serviceTier?: "default" }
  const wrap = (
    model: Model<Api>,
    options: StreamOptions | undefined,
    start: (bounded: Bounded) => AssistantMessageEventStream
  ): AssistantMessageEventStream => {
    const output = new AssistantMessageEventStream()
    let session: BudgetSession | undefined
    let message: AssistantMessage | undefined
    const run = async () => {
      try {
        const protocol = budgetProtocol(model.api)
        const usageEvidence =
          protocol === "openai-responses" ? undefined : createStreamUsageEvidence(protocol)
        const requested = options?.maxTokens ?? outputCap
        if (!Number.isSafeInteger(requested) || requested < 16)
          throw new Error("Invalid output token limit")
        const maxTokens = Math.min(requested, outputCap, model.maxTokens)
        const signal = options?.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000)
        session = createBudgetSession({
          protocol,
          getBudget: config.getBudget,
          model: {
            id: model.id,
            pricing: model.cost,
            limits: { context: model.contextWindow, output: model.maxTokens },
          },
          maxOutputTokens: maxTokens,
          mode: "stream",
          signal,
          ...(options?.fetch ? { fetch: options.fetch } : {}),
          ...(config.budgetTimeoutMs !== undefined
            ? { budgetTimeoutMs: config.budgetTimeoutMs }
            : {}),
        })
        const stream = start({
          maxTokens,
          ...(protocol === "openai-responses" ? { serviceTier: "default" as const } : {}),
          maxRetries: 0,
          timeoutMs: 120_000,
          signal,
          fetch: session.fetch,
          ...(usageEvidence
            ? {
                onProviderStreamEvent: async (raw: unknown, requestModel: Model<Api>) => {
                  usageEvidence.observe(raw)
                  await options?.onProviderStreamEvent?.(raw, requestModel)
                },
              }
            : {}),
          ...(protocol === "openai-responses"
            ? {
                onPayload: async (payload: unknown, requestModel: Model<Api>) =>
                  prepareOpenAIResponsesRequest(
                    (await options?.onPayload?.(payload, requestModel)) ?? payload,
                    { modelId: model.id, maxOutputTokens: maxTokens, mode: "stream" }
                  ).payload,
              }
            : options?.onPayload
              ? { onPayload: options.onPayload }
              : {}),
        })
        for await (const event of stream) {
          if (event.type !== "done" && event.type !== "error") output.push(event)
        }
        message = await stream.result()
        await session.settle(
          usageEvidence && !usageEvidence.isComplete ? undefined : measuredCost(message)
        )
        const reason = message.stopReason
        if (reason === "error" || reason === "aborted")
          output.push({ type: "error", reason, error: message })
        else if (
          reason === "stop" ||
          reason === "length" ||
          reason === "toolUse" ||
          reason === "deferred"
        )
          output.push({ type: "done", reason, message })
        else throw new Error("Model returned no terminal state")
      } catch (error) {
        const failure = failedMessage(model, error)
        output.push({
          type: "error",
          reason: "error",
          error:
            message && session?.authorized
              ? { ...message, stopReason: "error", errorMessage: failure.errorMessage }
              : failure,
        })
      }
      output.end()
    }
    const work = run()
    config.waitUntil?.(work)
    return output
  }
  const wrapped: Provider = {
    get id() {
      return provider.id
    },
    get name() {
      return provider.name
    },
    get auth() {
      return provider.auth
    },
    getModels: provider.getModels.bind(provider),
    ...(provider.getAllModels ? { getAllModels: provider.getAllModels.bind(provider) } : {}),
    ...(provider.refreshModels ? { refreshModels: provider.refreshModels.bind(provider) } : {}),
    ...(provider.filterModels ? { filterModels: provider.filterModels.bind(provider) } : {}),
    ...(provider.filterAllModels
      ? { filterAllModels: provider.filterAllModels.bind(provider) }
      : {}),
    stream: (model, context, options) =>
      wrap(model, options, (bounded) =>
        hasApi(model, "google-generative-ai")
          ? streamGoogle(model, context, { ...(options as GoogleOptions | undefined), ...bounded })
          : provider.stream<Api>(model, context, { ...options, ...bounded })
      ),
    streamSimple: (model, context, options) =>
      wrap(model, options, (bounded) =>
        hasApi(model, "google-generative-ai")
          ? streamGoogleSimple(model, context, { ...options, ...bounded })
          : provider.streamSimple(model, context, { ...options, ...bounded })
      ),
  }
  Object.defineProperties(wrapped, {
    baseUrl: { enumerable: true, get: () => provider.baseUrl },
    headers: { enumerable: true, get: () => provider.headers },
  })
  return wrapped
}
