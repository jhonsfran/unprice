import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider"
import { type BudgetHandle, BudgetSettleError } from "@unprice/budgets"
import {
  type BudgetProtocol,
  type ModelLimits,
  type TokenPricing,
  createBudgetSession,
  createStreamUsageEvidence,
  usageCost,
} from "@unprice/budgets-ai"
import type { LanguageModelMiddleware } from "ai"

const CALL_HEADER = "x-unprice-budget-call"
const CALL_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_TOKENS = 4096
const ANTHROPIC_FINISH_REASONS = new Set(["stop", "length", "tool-calls", "content-filter"])

type BudgetSession = ReturnType<typeof createBudgetSession>
type MiddlewareParams = Parameters<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>[0]
type CallParams = MiddlewareParams["params"]
type StreamEnd =
  | { kind: "part"; part: Extract<LanguageModelV4StreamPart, { type: "finish" | "error" }> }
  | { kind: "failure"; error: unknown }
  | { kind: "cancel" }

type ModelLimitsResolver = (modelId: string) => ModelLimits | Promise<ModelLimits>
export type UnpriceBudgetMiddlewareOptions = {
  getBudget: () => BudgetHandle | Promise<BudgetHandle>
  getPricing: (modelId: string) => TokenPricing | Promise<TokenPricing>
  maxOutputTokens?: number
  budgetTimeoutMs?: number
  waitUntil?: (work: Promise<unknown>) => void
  fetch?: typeof fetch
} & (
  | { protocol?: "openai-responses"; getModelLimits?: ModelLimitsResolver }
  | {
      protocol: Exclude<BudgetProtocol, "openai-responses">
      getModelLimits: ModelLimitsResolver
    }
)

function actualCost(pricing: TokenPricing, usage: LanguageModelV4Usage): number | undefined {
  const input = usage.inputTokens.total
  const output = usage.outputTokens.total
  const cacheRead = usage.inputTokens.cacheRead ?? 0
  const cacheWrite = usage.inputTokens.cacheWrite ?? 0
  if (
    input === undefined ||
    output === undefined ||
    ![input, output, cacheRead, cacheWrite].every(
      (count) => Number.isSafeInteger(count) && count >= 0
    ) ||
    input < cacheRead + cacheWrite ||
    input + output === 0
  ) {
    return undefined
  }
  return usageCost(pricing, {
    input: input - cacheRead - cacheWrite,
    output,
    cacheRead,
    cacheWrite,
  })
}

async function withAbort<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = () => aborted.reject(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    return await Promise.race([work, aborted.promise])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

/**
 * Pair the returned fetch with the provider and the returned middleware with wrapLanguageModel.
 * Supports text and local function tools. Each physical request needs a hold.
 */
export function createUnpriceBudgetMiddleware(options: UnpriceBudgetMiddlewareOptions): {
  fetch: typeof fetch
  middleware: LanguageModelMiddleware
} {
  const outputCap = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  if (!Number.isSafeInteger(outputCap) || outputCap < 16) {
    throw new RangeError("maxOutputTokens must be a safe integer of at least 16")
  }
  if (
    options.protocol !== undefined &&
    !["openai-responses", "anthropic-messages", "google-generative-ai"].includes(options.protocol)
  )
    throw new Error("Unsupported budget protocol")
  if (
    options.protocol !== undefined &&
    options.protocol !== "openai-responses" &&
    typeof options.getModelLimits !== "function"
  )
    throw new Error("getModelLimits is required for this budget protocol")
  const sessions = new Map<string, BudgetSession>()

  const startCall = async (
    params: CallParams,
    model: MiddlewareParams["model"],
    mode: "generate" | "stream"
  ) => {
    const token = params.headers?.[CALL_HEADER]
    if (!token || sessions.has(token)) throw new Error("Invalid budget middleware context")
    const signal = params.abortSignal ?? AbortSignal.timeout(CALL_TIMEOUT_MS)
    const resolvedPricing = await withAbort(
      Promise.resolve(options.getPricing(model.modelId)),
      signal
    )
    const pricing: TokenPricing = {
      ...resolvedPricing,
      ...(resolvedPricing.tiers
        ? { tiers: resolvedPricing.tiers.map((tier) => ({ ...tier })) }
        : {}),
    }
    const resolvedLimits = options.getModelLimits
      ? await withAbort(Promise.resolve(options.getModelLimits(model.modelId)), signal)
      : undefined
    const modelLimits = resolvedLimits === undefined ? undefined : { ...resolvedLimits }
    if (
      modelLimits &&
      (!Number.isSafeInteger(modelLimits.maxInputTokens) ||
        modelLimits.maxInputTokens <= 0 ||
        !Number.isSafeInteger(modelLimits.maxOutputTokens) ||
        modelLimits.maxOutputTokens < 16)
    )
      throw new Error(
        "Model limits must contain a positive input limit and an output limit of at least 16"
      )
    const sessionOptions = {
      getBudget: options.getBudget,
      modelId: model.modelId,
      pricing,
      maxOutputTokens: outputCap,
      mode,
      signal,
      ...(options.budgetTimeoutMs === undefined
        ? {}
        : { budgetTimeoutMs: options.budgetTimeoutMs }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }
    let session: BudgetSession
    if (options.protocol === "anthropic-messages" || options.protocol === "google-generative-ai") {
      if (!modelLimits) throw new Error("getModelLimits must return trusted model limits")
      session = createBudgetSession({ ...sessionOptions, protocol: options.protocol, modelLimits })
    } else {
      session = createBudgetSession({
        ...sessionOptions,
        protocol: "openai-responses",
        ...(modelLimits ? { modelLimits } : {}),
      })
    }
    params.maxOutputTokens = Math.min(
      params.maxOutputTokens ?? outputCap,
      outputCap,
      modelLimits?.maxOutputTokens ?? outputCap
    )
    const lifetime = Promise.withResolvers<void>()
    options.waitUntil?.(lifetime.promise)
    sessions.set(token, session)
    let settlement: Promise<void> | undefined
    return {
      signal,
      pricing,
      session,
      check() {
        if (session.error !== undefined) throw session.error
        if (!session.authorized) throw new Error("The model did not make a budgeted request")
      },
      settle(amount?: number) {
        if (!session.authorized) return Promise.resolve()
        settlement ??= session.settle(amount)
        return settlement
      },
      dispose() {
        sessions.delete(token)
        lifetime.resolve()
      },
    }
  }

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      const requested = params.maxOutputTokens ?? outputCap
      if (!Number.isSafeInteger(requested) || requested < 16) {
        throw new RangeError("maxOutputTokens must be a safe integer of at least 16")
      }
      const deadline = AbortSignal.timeout(CALL_TIMEOUT_MS)
      return {
        ...params,
        maxOutputTokens: Math.min(requested, outputCap),
        headers: { ...params.headers, [CALL_HEADER]: crypto.randomUUID() },
        abortSignal: params.abortSignal
          ? AbortSignal.any([params.abortSignal, deadline])
          : deadline,
      }
    },
    wrapGenerate: async ({ params, model, doGenerate }) => {
      const call = await startCall(params, model, "generate")
      const work = (async () => {
        let result: Awaited<ReturnType<typeof doGenerate>> | undefined
        try {
          result = await withAbort(doGenerate(), call.signal)
          call.check()
          const confirmed =
            options.protocol !== "anthropic-messages" ||
            ANTHROPIC_FINISH_REASONS.has(result.finishReason.unified)
          await call.settle(confirmed ? actualCost(call.pricing, result.usage) : undefined)
          return result
        } catch (error) {
          let failure = error
          try {
            await call.settle()
          } catch (settleError) {
            failure = settleError
          }
          if (failure instanceof BudgetSettleError && result !== undefined) {
            const recovery = {
              value: result,
              actual: failure.actual,
              hold: failure.hold,
              idempotencyKey: failure.idempotencyKey,
            }
            throw new BudgetSettleError(
              failure.error
                ? { ...recovery, error: failure.error }
                : { ...recovery, cause: failure.cause }
            )
          }
          throw call.session.error ?? failure
        } finally {
          call.dispose()
        }
      })()
      return await work
    },
    wrapStream: async ({ params, model, doStream }) => {
      const includeRawChunks = params.includeRawChunks === true
      const evidence =
        options.protocol === "anthropic-messages" || options.protocol === "google-generative-ai"
          ? createStreamUsageEvidence(options.protocol)
          : undefined
      if (evidence) params.includeRawChunks = true
      const call = await startCall(params, model, "stream")
      try {
        const result = await withAbort(doStream(), call.signal)
        call.check()
        const reader = result.stream.getReader()
        let cancelled = false
        let controller: ReadableStreamDefaultController<LanguageModelV4StreamPart> | undefined
        let ending: Promise<void> | undefined
        let failure: unknown
        const end = (terminal: StreamEnd): Promise<void> => {
          if (ending) return ending
          void reader.cancel().catch(() => undefined)
          ending = (async () => {
            try {
              const amount =
                terminal.kind === "part" &&
                terminal.part.type === "finish" &&
                (evidence === undefined || evidence.isComplete) &&
                (options.protocol !== "anthropic-messages" ||
                  ANTHROPIC_FINISH_REASONS.has(terminal.part.finishReason.unified))
                  ? actualCost(call.pricing, terminal.part.usage)
                  : undefined
              await call.settle(amount)
              if (!cancelled && controller) {
                call.signal.throwIfAborted()
                if (terminal.kind === "failure") controller.error(terminal.error)
                else {
                  if (terminal.kind === "part") controller.enqueue(terminal.part)
                  controller.close()
                }
              }
            } catch (error) {
              failure = call.session.error ?? error
              if (!cancelled) controller?.error(failure)
            } finally {
              call.signal.removeEventListener("abort", onAbort)
              call.dispose()
            }
          })()
          return ending
        }
        const onAbort = () => {
          void end({ kind: "failure", error: call.signal.reason })
        }
        const stream: typeof result.stream = new ReadableStream(
          {
            start(output) {
              controller = output
              call.signal.addEventListener("abort", onAbort, { once: true })
              if (call.signal.aborted) onAbort()
            },
            async pull(output) {
              if (ending) return await ending
              try {
                for (;;) {
                  const { value, done } = await withAbort(reader.read(), call.signal)
                  if (ending) return await ending
                  if (done) {
                    return await end({
                      kind: "failure",
                      error: new Error("The model stream ended without final usage"),
                    })
                  }
                  if (value.type === "raw" && evidence) {
                    evidence.observe(value.rawValue)
                    if (!includeRawChunks) continue
                  }
                  if (value.type === "finish" || value.type === "error") {
                    return await end({ kind: "part", part: value })
                  }
                  output.enqueue(value)
                  return
                }
              } catch (error) {
                await end({ kind: "failure", error: call.session.error ?? error })
              }
            },
            async cancel() {
              cancelled = true
              await end({ kind: "cancel" })
              if (failure !== undefined) throw failure
            },
          },
          { highWaterMark: 0 }
        )
        return { ...result, stream }
      } catch (error) {
        try {
          await call.settle()
        } finally {
          call.dispose()
        }
        throw call.session.error ?? error
      }
    },
  }

  return {
    middleware,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const token = request.headers.get(CALL_HEADER)
      const session = token ? sessions.get(token) : undefined
      if (!session) throw new Error("Use the matching Unprice budget middleware with this fetch")
      const headers = new Headers(request.headers)
      headers.delete(CALL_HEADER)
      return session.fetch(new Request(request, { headers }))
    },
  }
}
