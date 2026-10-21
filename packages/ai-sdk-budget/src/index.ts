import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  ProviderV2,
  ProviderV3,
  ProviderV4,
} from "@ai-sdk/provider"
import {
  type BudgetDefinitionInput,
  type BudgetHandle,
  BudgetSettleError,
  type ModelRate,
  type Unprice,
} from "@unprice/budgets"
import {
  type BudgetProtocol,
  type BudgetStepSettlement,
  type ModelLimits,
  type TokenPricing,
  createBudgetSession,
  createStreamUsageEvidence,
  usageCost,
} from "@unprice/budgets-ai"
import { type LanguageModelMiddleware, type StopCondition, type ToolSet, wrapProvider } from "ai"

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

/** A model's rates and limits, as the catalog serves them, for a model the catalog does not know. */
export type ModelRateInput = Pick<ModelRate, "rates" | "limits"> & { tiers?: ModelRate["tiers"] }

export type UnpriceBudgetMiddlewareOptions = {
  unprice: Pick<Unprice, "budget" | "model">
  /** The budget key of a call that names none in `providerOptions.unprice.budget`. */
  budget?: string
  /**
   * The budget to create when a key has none: unit and limits, as an upsert takes them. The first
   * call on a new key creates it; an existing budget is never changed.
   */
  defaults?: BudgetDefinitionInput
  /** The handle for a key. Defaults to `unprice.budget(key, { ifMissing: defaults })`. */
  budgets?: (key: string) => BudgetHandle | Promise<BudgetHandle>
  /** Rates by `provider/model` id that replace the catalog's row, or add a model it lacks. */
  models?: Record<string, ModelRateInput>
  maxOutputTokens?: number
  budgetTimeoutMs?: number
  waitUntil?: (work: Promise<unknown>) => void
  fetch?: typeof fetch
}

/** What a model's `provider` id says about its wire protocol and its catalog provider. */
const PROTOCOLS: ReadonlyArray<{
  suffix: string
  protocol: BudgetProtocol
  provider: ModelRate["provider"]
}> = [
  { suffix: ".responses", protocol: "openai-responses", provider: "openai" },
  { suffix: ".messages", protocol: "anthropic-messages", provider: "anthropic" },
  { suffix: ".generative-ai", protocol: "google-generative-ai", provider: "google" },
]

function protocolOf(model: Pick<LanguageModelV4, "provider" | "modelId">) {
  const entry = PROTOCOLS.find(({ suffix }) => model.provider.endsWith(suffix))
  if (!entry)
    throw new Error(
      `Unsupported model provider "${model.provider}": budgets cover OpenAI Responses, Anthropic Messages, and Google Generative AI models`
    )
  return { protocol: entry.protocol, catalogId: `${entry.provider}/${model.modelId}` }
}

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

function budgetKeyOf(providerOptions: CallParams["providerOptions"]): string | undefined {
  const unprice = providerOptions?.unprice
  if (unprice === undefined) return undefined
  const key = unprice.budget
  if (typeof key !== "string" || key.length === 0)
    throw new Error("providerOptions.unprice.budget must be a budget key")
  return key
}

/**
 * Pair the returned fetch with the provider and the returned middleware with wrapLanguageModel.
 * `budgeted` does both. Supports text and local function tools. Each physical request needs a
 * hold, priced from the catalog row of the model.
 */
export function createUnpriceBudgetMiddleware(options: UnpriceBudgetMiddlewareOptions): {
  fetch: typeof fetch
  middleware: LanguageModelMiddleware
} {
  const outputCap = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  if (!Number.isSafeInteger(outputCap) || outputCap < 16) {
    throw new RangeError("maxOutputTokens must be a safe integer of at least 16")
  }
  const sessions = new Map<string, BudgetSession>()
  /** The budget key each call named, from transformParams to startCall. */
  const keys = new Map<string, string | undefined>()

  const resolveModel = async (
    catalogId: string,
    modelId: string,
    signal: AbortSignal
  ): Promise<{ pricing: TokenPricing; limits: ModelLimits }> => {
    let rate: ModelRateInput | undefined = options.models?.[catalogId] ?? options.models?.[modelId]
    if (!rate) {
      const answer = await withAbort(options.unprice.model(catalogId), signal)
      if (answer.error)
        throw new Error(
          `Model ${catalogId} is not in the Unprice catalog (${answer.error.code}); pass its rates in the models option`
        )
      rate = answer.result
    }
    return {
      pricing: {
        ...rate.rates,
        ...(rate.tiers ? { tiers: rate.tiers.map((tier) => ({ ...tier })) } : {}),
      },
      limits: { ...rate.limits },
    }
  }

  const startCall = async (
    params: CallParams,
    model: MiddlewareParams["model"],
    mode: "generate" | "stream"
  ) => {
    const token = params.headers?.[CALL_HEADER]
    if (!token || sessions.has(token)) throw new Error("Invalid budget middleware context")
    const key = keys.get(token) ?? options.budget
    keys.delete(token)
    if (!key)
      throw new Error(
        "Name a budget for the call: providerOptions.unprice.budget, or the budget option of the wrapper"
      )
    const { protocol, catalogId } = protocolOf(model)
    const signal = params.abortSignal ?? AbortSignal.timeout(CALL_TIMEOUT_MS)
    const { pricing, limits } = await resolveModel(catalogId, model.modelId, signal)
    const handle = options.budgets
      ? options.budgets(key)
      : options.unprice.budget(key, options.defaults ? { ifMissing: options.defaults } : {})
    const session = createBudgetSession({
      protocol,
      getBudget: () => handle,
      model: { id: model.modelId, pricing, limits },
      maxOutputTokens: outputCap,
      mode,
      signal,
      ...(options.budgetTimeoutMs === undefined
        ? {}
        : { budgetTimeoutMs: options.budgetTimeoutMs }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
    params.maxOutputTokens = Math.min(params.maxOutputTokens ?? outputCap, outputCap, limits.output)
    const lifetime = Promise.withResolvers<void>()
    options.waitUntil?.(lifetime.promise)
    sessions.set(token, session)
    let settlement: Promise<BudgetStepSettlement | undefined> | undefined
    return {
      signal,
      pricing,
      protocol,
      session,
      check() {
        if (session.error !== undefined) throw session.error
        if (!session.authorized) throw new Error("The model did not make a budgeted request")
      },
      settle(amount?: number) {
        if (!session.authorized) return Promise.resolve(undefined)
        settlement ??= session.settle(amount)
        return settlement
      },
      metadata(settled: BudgetStepSettlement | undefined) {
        const reserved = session.reserved
        const remaining = settled?.balance.remaining ?? null
        return {
          budget: key,
          holdId: reserved?.hold.id ?? null,
          hold: reserved?.hold.amount ?? null,
          actual: settled?.actual ?? null,
          remaining,
          exceeded: settled?.exceeded ?? false,
          requestedOutputTokens: reserved?.requestedOutputTokens ?? null,
          outputTokens: reserved?.outputTokens ?? null,
          inputSource: reserved?.inputSource ?? null,
          exhausted: session.exhausted(remaining),
        }
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
      const token = crypto.randomUUID()
      keys.set(token, budgetKeyOf(params.providerOptions))
      const { unprice: _, ...providerOptions } = params.providerOptions ?? {}
      const deadline = AbortSignal.timeout(CALL_TIMEOUT_MS)
      return {
        ...params,
        providerOptions,
        maxOutputTokens: Math.min(requested, outputCap),
        headers: { ...params.headers, [CALL_HEADER]: token },
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
            call.protocol !== "anthropic-messages" ||
            ANTHROPIC_FINISH_REASONS.has(result.finishReason.unified)
          const settled = await call.settle(
            confirmed ? actualCost(call.pricing, result.usage) : undefined
          )
          return {
            ...result,
            providerMetadata: { ...result.providerMetadata, unprice: call.metadata(settled) },
          }
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
              recovery: failure.recovery,
              retry: failure.retry,
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
      const call = await startCall(params, model, "stream")
      const evidence =
        call.protocol === "openai-responses" ? undefined : createStreamUsageEvidence(call.protocol)
      if (evidence) params.includeRawChunks = true
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
                (call.protocol !== "anthropic-messages" ||
                  ANTHROPIC_FINISH_REASONS.has(terminal.part.finishReason.unified))
                  ? actualCost(call.pricing, terminal.part.usage)
                  : undefined
              const settled = await call.settle(amount)
              if (!cancelled && controller) {
                call.signal.throwIfAborted()
                if (terminal.kind === "failure") controller.error(terminal.error)
                else {
                  if (terminal.kind === "part") {
                    const { part } = terminal
                    controller.enqueue(
                      part.type === "finish"
                        ? {
                            ...part,
                            providerMetadata: {
                              ...part.providerMetadata,
                              unprice: call.metadata(settled),
                            },
                          }
                        : part
                    )
                  }
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

/**
 * A stop condition for `generateText` and `streamText`: true once the last step's settlement
 * left less than a step with the same prompt and the smallest output would need. The loop then
 * ends cleanly instead of failing on the next step's denied hold.
 */
export function budgetSpent<TOOLS extends ToolSet = ToolSet>(): StopCondition<TOOLS> {
  return ({ steps }) => steps.at(-1)?.providerMetadata?.unprice?.exhausted === true
}

export type BudgetedOptions = Omit<UnpriceBudgetMiddlewareOptions, "fetch">

/** The provider `budgeted` returns: callable like the factory's own, and a full provider. */
export type BudgetedProvider = ((modelId: string) => LanguageModelV4) & ProviderV4

/**
 * A provider whose every language model runs inside the budget: the factory gets the paired
 * fetch, and every model it returns gets the middleware. The developer's own `fetch` in
 * `settings` still carries the model traffic.
 *
 * @example
 * const openai = budgeted(createOpenAI, { unprice, budget: `customer:${user.id}` })
 * await generateText({ model: openai("gpt-5"), prompt })
 */
export function budgeted<
  S extends { fetch?: typeof fetch },
  P extends ProviderV4 | ProviderV3 | ProviderV2,
>(createProvider: (settings?: S) => P, options: BudgetedOptions, settings?: S): BudgetedProvider {
  const budget = createUnpriceBudgetMiddleware({
    ...options,
    ...(settings?.fetch ? { fetch: settings.fetch } : {}),
  })
  const provider = createProvider(Object.assign({}, settings, { fetch: budget.fetch }))
  const wrapped = wrapProvider({ provider, languageModelMiddleware: budget.middleware })
  return Object.assign((modelId: string) => wrapped.languageModel(modelId), wrapped)
}
