import {
  BudgetExceededError,
  type BudgetHandle,
  type BudgetHold,
  BudgetRequestError,
  BudgetSettleError,
  type BudgetSettlement,
  BudgetUnavailableError,
} from "@unprice/budgets"
import { DEFAULT_BUDGET_TIMEOUT_MS, withDeadline } from "./deadline"
export { DEFAULT_BUDGET_TIMEOUT_MS, withDeadline } from "./deadline"
export { MESSAGE_OVERHEAD_TOKENS, REQUEST_OVERHEAD_TOKENS, inputBound } from "./input-bound"
import { prepareBudgetRequest } from "./provider-request"
import type { BudgetProtocol, ModelLimits } from "./request-policy"
export type { BudgetProtocol, ModelLimits } from "./request-policy"
export { createStreamUsageEvidence, type StreamUsageEvidence } from "./stream-usage-evidence"
export { prepareRequest as prepareOpenAIResponsesRequest } from "./openai-request"

export interface TokenRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** USD per million tokens, including optional whole-request context tiers. */
export interface TokenPricing extends TokenRates {
  tiers?: readonly (TokenRates & { inputTokensAbove: number })[]
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** The model a session prices: the id the provider expects, its rates, and its limits. */
export interface BudgetModel {
  id: string
  pricing: TokenPricing
  limits: ModelLimits
}

const PROTOCOLS: readonly BudgetProtocol[] = [
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]

function validatedPricing(pricing: TokenPricing): TokenPricing {
  const rates = [pricing, ...(pricing.tiers ?? [])]
  for (const tier of pricing.tiers ?? []) {
    if (!Number.isSafeInteger(tier.inputTokensAbove) || tier.inputTokensAbove < 0)
      throw new Error("Pricing tiers require a nonnegative integer input token threshold")
  }
  for (const rate of rates) {
    if (
      ![rate.input, rate.output, rate.cacheRead, rate.cacheWrite].every(
        (value) => Number.isFinite(value) && value >= 0
      )
    )
      throw new Error("Model has invalid budget pricing")
  }
  return {
    ...pricing,
    ...(pricing.tiers ? { tiers: pricing.tiers.map((tier) => ({ ...tier })) } : {}),
  }
}

function validatedLimits(limits: ModelLimits): ModelLimits {
  if (
    !Number.isSafeInteger(limits.context) ||
    limits.context <= 0 ||
    !Number.isSafeInteger(limits.output) ||
    limits.output < 16
  )
    throw new Error("Invalid model limits: context must be positive and output at least 16")
  return { context: limits.context, output: limits.output }
}

/** The most a step can cost at the highest rates, rounded up at eight decimals. */
export function maximumCost(
  pricing: TokenPricing,
  inputTokens: number,
  outputTokens: number
): number {
  const rates = [pricing, ...(pricing.tiers ?? [])]
  const inputRate = Math.max(
    ...rates.flatMap((rate) => [rate.input, rate.cacheRead, rate.cacheWrite])
  )
  const outputRate = Math.max(...rates.map((rate) => rate.output))
  const cost = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000
  if (!Number.isFinite(cost) || cost <= 0) throw new Error("Model has no valid budget pricing")
  return Math.ceil(cost * 100_000_000) / 100_000_000
}

/** Input excludes cache tokens. Output includes reasoning tokens. */
export function usageCost(pricing: TokenPricing, usage: TokenUsage): number {
  const validated = validatedPricing(pricing)
  if (!Object.values(usage).every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error("Invalid model token usage")
  const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite
  let rate: TokenRates = validated
  let threshold = -1
  for (const tier of validated.tiers ?? []) {
    if (contextTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      rate = tier
      threshold = tier.inputTokensAbove
    }
  }
  const cost =
    (usage.input * rate.input +
      usage.output * rate.output +
      usage.cacheRead * rate.cacheRead +
      usage.cacheWrite * rate.cacheWrite) /
    1_000_000
  if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid model usage cost")
  return cost
}

export interface BudgetSessionOptions {
  getBudget: () => BudgetHandle | Promise<BudgetHandle>
  /** The provider wire protocol of the request. Defaults to OpenAI Responses. */
  protocol?: BudgetProtocol
  model: BudgetModel
  maxOutputTokens: number
  mode: "stream" | "generate"
  budgetTimeoutMs?: number
  signal?: AbortSignal
  fetch?: typeof globalThis.fetch
}

/** What the session reserved for its one request, once authorized. */
export interface BudgetReservation {
  readonly hold: BudgetHold
  readonly inputTokens: number
  readonly outputTokens: number
  readonly maximumCost: number
}

export interface BudgetSession {
  readonly fetch: typeof globalThis.fetch
  readonly authorized: boolean
  readonly error: unknown
  readonly reserved: BudgetReservation | undefined
  /** Settles once and resolves with the settlement; later calls return the same promise. */
  settle(actualCost?: number): Promise<BudgetSettlement>
}

type RequestState =
  | { status: "ready" | "preparing" }
  | { status: "blocked"; error: unknown }
  | { status: "authorized"; reserved: BudgetReservation; key: string }

/** One physical model dispatch and its settlement, independent of any model SDK. */
export function createBudgetSession(options: BudgetSessionOptions): BudgetSession {
  const protocol: BudgetProtocol = options.protocol ?? "openai-responses"
  if (!PROTOCOLS.includes(protocol)) throw new Error("Unsupported budget protocol")
  const pricing = validatedPricing(options.model.pricing)
  const limits = validatedLimits(options.model.limits)
  if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 16)
    throw new Error("maxOutputTokens must be a safe integer of at least 16")
  const cap = Math.min(options.maxOutputTokens, limits.output)
  const timeoutMs = options.budgetTimeoutMs ?? DEFAULT_BUDGET_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error("budgetTimeoutMs must be a positive 32-bit integer")
  const modelId = options.model.id
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis)
  const callSignal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000)
  let state: RequestState = { status: "ready" }
  let settlement: Promise<BudgetSettlement> | undefined
  let failure: unknown

  return {
    get authorized() {
      return state.status === "authorized"
    },
    get error() {
      return failure
    },
    get reserved() {
      return state.status === "authorized" ? state.reserved : undefined
    },
    fetch: async (input, init) => {
      if (state.status !== "ready") {
        failure = new Error("A budget session permits one generation request")
        throw failure
      }
      state = { status: "preparing" }
      let generation: Request
      try {
        callSignal.throwIfAborted()
        const incoming = new Request(input, init)
        const signal = AbortSignal.any([callSignal, incoming.signal])
        const bounded = await withDeadline(
          () =>
            prepareBudgetRequest(
              new Request(incoming, { signal }),
              { modelId, maxOutputTokens: cap, mode: options.mode },
              protocol
            ),
          { timeoutMs: 120_000, signal }
        )
        generation = bounded.request
        const maximum = maximumCost(pricing, bounded.inputTokens, bounded.outputTokens)
        const key = crypto.randomUUID()
        const authorized = await withDeadline(
          async (budgetSignal) => {
            const budget = await options.getBudget()
            budgetSignal.throwIfAborted()
            return budget.authorize({ amount: maximum, ttlMs: 300_000, idempotencyKey: key })
          },
          { timeoutMs, signal }
        )
        if (authorized.error) throw new BudgetRequestError(authorized.error, key)
        if (!authorized.result.allowed) {
          if (authorized.result.degraded)
            throw new BudgetUnavailableError(authorized.result.blocked.error, key)
          throw new BudgetExceededError(authorized.result, key)
        }
        if (authorized.result.replayed) throw new Error("Budget authorization was replayed")
        state = {
          status: "authorized",
          reserved: {
            hold: authorized.result.hold,
            inputTokens: bounded.inputTokens,
            outputTokens: bounded.outputTokens,
            maximumCost: maximum,
          },
          key,
        }
        signal.throwIfAborted()
        if (failure !== undefined) throw failure
      } catch (error) {
        failure = error
        if (state.status !== "authorized") state = { status: "blocked", error }
        throw error
      }
      return transport(generation)
    },
    settle(actualCost) {
      if (settlement) return settlement
      const authorized = state
      settlement = (async () => {
        if (authorized.status === "blocked") throw authorized.error
        if (authorized.status !== "authorized") throw new Error("Model request was not budgeted")
        const { hold, maximumCost: reserved } = authorized.reserved
        const amount =
          typeof actualCost === "number" && Number.isFinite(actualCost) && actualCost >= 0
            ? actualCost
            : reserved
        let settled: Awaited<ReturnType<BudgetHold["settle"]>>
        try {
          settled = await withDeadline(() => hold.settle({ amount }), { timeoutMs })
        } catch (cause) {
          throw new BudgetSettleError({
            value: undefined,
            actual: amount,
            hold,
            idempotencyKey: authorized.key,
            cause,
          })
        }
        if (settled.error)
          throw new BudgetSettleError({
            value: undefined,
            actual: amount,
            hold,
            idempotencyKey: authorized.key,
            error: settled.error,
          })
        if (failure !== undefined) throw failure
        return settled.result
      })()
      return settlement
    },
  }
}
