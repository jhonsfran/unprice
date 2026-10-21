import type { ApiError, ErrorResponse } from "./errors"
import type { GeneratedSdkResources } from "./generated/sdk-resources"
import type { OperationInput, OperationResponse } from "./operation-types"
import type { ApiResult } from "./result"
import type { UnpriceOptions } from "./transport"

type BudgetResources = GeneratedSdkResources["budgets"]

/** A decimal string such as `"0.05"`, or a finite number rounded to 8 decimal places. */
export type AmountInput = number | string

export type BudgetBalance = OperationResponse<"budgets.get">["budget"]["balance"]

type BudgetExceededDetails = Extract<
  NonNullable<Extract<ErrorResponse["error"], { code: "BUDGET_EXCEEDED" }>["details"]>,
  { kind: "budget_exceeded" }
>

export type BudgetBlocked =
  | ({ reason: "limit" } & BudgetExceededDetails["blocked"])
  | { reason: "unavailable"; remedy: "retry"; error: ApiError }

export type BudgetDenial =
  | {
      allowed: false
      degraded: false
      blocked: Extract<BudgetBlocked, { reason: "limit" }>
      balance: BudgetBalance
    }
  | {
      allowed: false
      degraded: true
      blocked: Extract<BudgetBlocked, { reason: "unavailable" }>
      balance: null
    }

export type BudgetSettlement = OperationResponse<"budgets.settle">
export type BudgetRelease = OperationResponse<"budgets.release">

/** How `spend` settles: before it returns, or through the client's `waitUntil`. */
export type SpendSettlement = {
  waitUntil?: UnpriceOptions["waitUntil"]
  onSettleError?: UnpriceOptions["onSettleError"]
}

export type BudgetHold = {
  readonly id: string
  readonly key: string
  readonly amount: string
  /**
   * Deadline for the work, in epoch ms. A hold still open then is settled at its full amount, so
   * only a settle of that amount succeeds afterwards.
   */
  readonly expiresAt: number
  /**
   * Final usage must not exceed the authorized amount. An excess returns 409 and keeps the hold
   * open. The same settled amount replays for 24 hours after closure; later retries return 409.
   */
  settle(input: { amount: AmountInput }): Promise<ApiResult<BudgetSettlement>>
  /** Safe to retry. Call it only when the work produced no usage. */
  release(): Promise<ApiResult<BudgetRelease>>
}

/**
 * The budget a handle creates on first use: an upsert body without the key (ADR-0006 D8). It is
 * sent with every authorize, charge, and lease; an existing budget ignores it.
 */
export type BudgetDefinitionInput = NonNullable<OperationInput<"budgets.authorize">["ifMissing"]>

export type BudgetAuthorization =
  | {
      allowed: true
      degraded: false
      hold: BudgetHold
      balance: BudgetBalance
      replayed: boolean
      /** This call created the budget from the handle's `ifMissing`. */
      created: boolean
    }
  | BudgetDenial

export type BudgetCharge =
  | ({ allowed: true; degraded: false } & Omit<OperationResponse<"budgets.charge">, "allowed">)
  | BudgetDenial

export type AuthorizeBudgetInput = {
  /** Maximum usage the work can incur. Enforce this maximum in the provider integration. */
  amount: AmountInput
  ttlMs?: number
  /** Keep this key and reuse it if the authorization response is lost. */
  idempotencyKey: string
}

export type ChargeBudgetInput = {
  amount: AmountInput
  /** Keep this key and reuse it if the charge response is lost. */
  idempotencyKey: string
}

/**
 * Usage that already happened. It always counts, even past a hard limit, and `crossed` names any
 * limit it passed; authorize before work that needs guaranteed capacity. Within 25 hours, the same
 * event key and amount replay; another amount is 409.
 */
export type RecordBudgetInput = {
  amount: AmountInput
  idempotencyKey: string
  /**
   * When the usage happened, in epoch ms: the event's own time, never the time of the call. Usage
   * older than 24 hours is refused (409), which is what stops a retry from counting twice once its
   * key's 25-hour dedupe has ended, so a retry must send the same time.
   */
  occurredAt: number
}

export type SpendBudgetInput = {
  /** Maximum authorized usage, which the callback's provider integration must enforce. */
  estimate: AmountInput
  ttlMs?: number
  /**
   * Defaults to a random UUID, which budget errors expose for recovery. With your own key, a
   * replay may follow an earlier run of the work, so `spend` throws instead of running it again.
   */
  idempotencyKey?: string
}

export type BudgetHandle = {
  readonly key: string
  /** Immediate usable capacity of a local lease. Authorization remains authoritative. */
  readonly spendableAmount?: string | undefined
  /** A limit denial is `{ allowed: false }`. When Unprice cannot be reached, the denial is `degraded`. */
  authorize(input: AuthorizeBudgetInput): Promise<ApiResult<BudgetAuthorization>>
  charge(input: ChargeBudgetInput): Promise<ApiResult<BudgetCharge>>
  record(input: RecordBudgetInput): Promise<ApiResult<OperationResponse<"budgets.record">>>
  get(): Promise<ApiResult<OperationResponse<"budgets.get">>>
  /**
   * Authorizes `estimate` as the maximum usage, runs `fn` for a new authorization, and settles
   * usage within that maximum. The callback must enforce the maximum at the provider.
   * Failure or timeout retains the hold because the work may have incurred cost.
   *
   * @throws BudgetExceededError when a limit denies the estimate.
   * @throws BudgetUnavailableError when Unprice cannot be reached after the client's retries.
   * @throws BudgetRequestError when the API rejects the authorization.
   * @throws BudgetRecoveryError when your idempotency key replays or `fn` throws. Recover with
   * its hold.
   * @throws BudgetSettleError when `fn` succeeded but the settle failed. With the client's
   * `waitUntil`, `spend` returns once `fn` finishes and passes this error to `onSettleError`.
   */
  spend<T>(
    input: SpendBudgetInput,
    fn: (hold: BudgetHold) => Promise<{ value: T; actual: AmountInput }>
  ): Promise<T>
  /**
   * `fn` with a charge of `price.amount` in front. As an AI SDK tool's `execute`, the charge is
   * keyed by the call's `toolCallId`, so a tool call that runs again replays its charge instead of
   * paying twice; any other call charges under a fresh key. A denied charge throws and `fn` does
   * not run. A replayed charge still runs `fn`, and the charge stands when `fn` throws: the
   * vendor may have billed the call either way.
   *
   * @throws BudgetExceededError when a limit denies the charge.
   * @throws BudgetUnavailableError when Unprice cannot be reached after the client's retries.
   * @throws BudgetRequestError when the API rejects the charge.
   */
  wrap<A extends unknown[], R>(
    price: { amount: AmountInput },
    fn: (...args: A) => R
  ): (...args: A) => Promise<Awaited<R>>
}

/** A limit denied the estimate. `blocked` names it and the remedy. */
export class BudgetExceededError extends Error {
  readonly blocked: Extract<BudgetBlocked, { reason: "limit" }>
  readonly balance: BudgetBalance

  constructor(
    denial: Extract<BudgetDenial, { degraded: false }>,
    readonly idempotencyKey: string
  ) {
    super(`Budget exceeded: limit ${denial.blocked.limitId} (${denial.blocked.remedy})`)
    this.name = "BudgetExceededError"
    this.blocked = denial.blocked
    this.balance = denial.balance
  }
}

/**
 * Unprice could not be reached, or answered 429 or 500 after the client's retries, so nothing ran.
 * The authorization may still have committed: retry with the same estimate, TTL, and
 * `idempotencyKey` so it replays instead of holding twice.
 */
export class BudgetUnavailableError extends Error {
  constructor(
    readonly error: ApiError,
    readonly idempotencyKey: string
  ) {
    super(`Budget unavailable: ${error.message}`)
    this.name = "BudgetUnavailableError"
  }
}

export class BudgetRequestError extends Error {
  constructor(
    readonly error: ApiError,
    readonly idempotencyKey: string
  ) {
    super(`Budget request failed: ${error.code} ${error.message}`)
    this.name = "BudgetRequestError"
  }
}

/**
 * The SDK cannot determine the work's usage. Recover through `hold`; never rerun the callback
 * without checking the provider's result. Release only after confirming that usage is zero.
 */
export class BudgetRecoveryError extends Error {
  readonly reason: "work_failed" | "authorization_replayed"
  readonly hold: BudgetHold
  readonly idempotencyKey: string

  constructor(
    input: {
      hold: BudgetHold
      idempotencyKey: string
    } & ({ reason: "work_failed"; cause: unknown } | { reason: "authorization_replayed" })
  ) {
    super(
      input.reason === "work_failed"
        ? `Work failed for hold ${input.hold.id}; recover its usage before releasing`
        : `Authorization replayed for hold ${input.hold.id}; work was not run`,
      input.reason === "work_failed" ? { cause: input.cause } : undefined
    )
    this.name = "BudgetRecoveryError"
    this.reason = input.reason
    this.hold = input.hold
    this.idempotencyKey = input.idempotencyKey
  }
}

/**
 * The work produced `value`, but settlement failed. After a transport failure, retry the same
 * hold and actual amount. An amount above the hold requires reconciliation, not a smaller claim.
 * When `retry` is present, use it to complete the fixed `recovery` intent, including any excess
 * usage record before settlement. Persist that intent if recovery must survive process loss.
 * A closed hold retains its replay result for 24 hours.
 */
export class BudgetSettleError extends Error {
  readonly value: unknown
  readonly actual: AmountInput
  readonly hold: BudgetHold
  readonly error: ApiError | undefined
  readonly idempotencyKey: string
  readonly recovery: Readonly<{ amount: string; record?: Readonly<RecordBudgetInput> }> | undefined
  readonly retry: (() => Promise<void>) | undefined

  constructor(
    input: {
      value: unknown
      actual: AmountInput
      hold: BudgetHold
      idempotencyKey: string
      recovery?: BudgetSettleError["recovery"]
      retry?: BudgetSettleError["retry"]
    } & ({ error: ApiError } | { cause: unknown })
  ) {
    super(
      "error" in input
        ? `Settle failed for hold ${input.hold.id}: ${input.error.code} ${input.error.message}`
        : `Settle failed for hold ${input.hold.id}`,
      "cause" in input ? { cause: input.cause } : undefined
    )
    this.name = "BudgetSettleError"
    this.value = input.value
    this.actual = input.actual
    this.hold = input.hold
    this.error = "error" in input ? input.error : undefined
    this.idempotencyKey = input.idempotencyKey
    this.recovery = input.recovery
    this.retry = input.retry
  }
}

export const toDecimal = (amount: AmountInput): string => {
  if (typeof amount === "string") {
    return amount
  }

  if (!Number.isFinite(amount)) {
    throw new RangeError(`Budget amounts must be finite, received ${amount}`)
  }

  // toFixed(8) snaps float noise such as 0.1 + 0.2 onto the API's 8-decimal grid.
  return amount.toFixed(8).replace(/\.?0+$/, "")
}

const newIdempotencyKey = () => globalThis.crypto.randomUUID()

// The answer of a lost or refused request may still have committed; resending it is safe.
export const retryable = (error: ApiError) =>
  error.code === "FETCH_ERROR" ||
  error.code === "INTERNAL_SERVER_ERROR" ||
  error.code === "TOO_MANY_REQUESTS"

// Only a transport failure is "unavailable". An API error response means Unprice answered.
export const toDenial = (error: ApiError): BudgetDenial | null => {
  if (error.code === "FETCH_ERROR") {
    return {
      allowed: false,
      degraded: true,
      blocked: { reason: "unavailable", remedy: "retry", error },
      balance: null,
    }
  }

  if (error.code === "BUDGET_EXCEEDED" && error.details?.kind === "budget_exceeded") {
    return {
      allowed: false,
      degraded: false,
      blocked: { reason: "limit", ...error.details.blocked },
      balance: error.details.balance,
    }
  }

  return null
}

const createHold = (
  budgets: BudgetResources,
  key: string,
  authorized: OperationResponse<"budgets.authorize">
): BudgetHold => ({
  id: authorized.holdId,
  key,
  amount: authorized.amount,
  expiresAt: authorized.expiresAt,
  settle: ({ amount }) =>
    budgets.settle({ key, holdId: authorized.holdId, amount: toDecimal(amount) }),
  release: () => budgets.release({ key, holdId: authorized.holdId }),
})

/** `spend` over any `authorize`, so the remote and local handles share one contract. */
export const createSpend =
  (
    authorize: BudgetHandle["authorize"],
    { waitUntil, onSettleError }: SpendSettlement = {}
  ): BudgetHandle["spend"] =>
  async ({ estimate, idempotencyKey: ownKey, ...options }, fn) => {
    const idempotencyKey = ownKey ?? newIdempotencyKey()
    const authorized = await authorize({ ...options, amount: estimate, idempotencyKey })

    if (authorized.error) {
      if (retryable(authorized.error)) {
        throw new BudgetUnavailableError(authorized.error, idempotencyKey)
      }
      throw new BudgetRequestError(authorized.error, idempotencyKey)
    }

    if (!authorized.result.allowed) {
      if (authorized.result.degraded) {
        throw new BudgetUnavailableError(authorized.result.blocked.error, idempotencyKey)
      }
      throw new BudgetExceededError(authorized.result, idempotencyKey)
    }

    const { hold } = authorized.result
    // A generated key never left this call, so its replay is the client retrying a lost
    // response and the work has not run. Your own key may replay a run that already happened.
    if (authorized.result.replayed && ownKey !== undefined) {
      throw new BudgetRecoveryError({ reason: "authorization_replayed", hold, idempotencyKey })
    }
    let outcome: Awaited<ReturnType<typeof fn>>

    try {
      outcome = await fn(hold)
    } catch (cause) {
      throw new BudgetRecoveryError({ reason: "work_failed", cause, hold, idempotencyKey })
    }

    const failure = settleOutcome(hold, outcome, idempotencyKey)
    if (waitUntil) {
      waitUntil(
        failure.then((error) => {
          if (error) onSettleError?.(error)
        })
      )
      return outcome.value
    }

    const error = await failure
    if (error) throw error
    return outcome.value
  }

// Resolves with the failure instead of rejecting, so a background settle never rejects.
const settleOutcome = async (
  hold: BudgetHold,
  { value, actual }: { value: unknown; actual: AmountInput },
  idempotencyKey: string
): Promise<BudgetSettleError | null> => {
  let settled: ApiResult<BudgetSettlement>
  try {
    settled = await hold.settle({ amount: actual })
  } catch (cause) {
    return new BudgetSettleError({ value, actual, hold, cause, idempotencyKey })
  }

  if (settled.error) {
    return new BudgetSettleError({ value, actual, hold, error: settled.error, idempotencyKey })
  }

  return null
}

const toolCallIdOf = (options: unknown): string | undefined =>
  typeof options === "object" &&
  options !== null &&
  "toolCallId" in options &&
  typeof options.toolCallId === "string" &&
  options.toolCallId.length > 0
    ? options.toolCallId
    : undefined

/** `wrap` over any `charge`, so the remote and local handles share one contract. */
export function createWrap(charge: BudgetHandle["charge"]): BudgetHandle["wrap"] {
  return <A extends unknown[], R>(price: { amount: AmountInput }, fn: (...args: A) => R) =>
    async (...args: A): Promise<Awaited<R>> => {
      const idempotencyKey = toolCallIdOf(args[1]) ?? newIdempotencyKey()
      const charged = await charge({ amount: price.amount, idempotencyKey })
      if (charged.error) {
        if (retryable(charged.error)) {
          throw new BudgetUnavailableError(charged.error, idempotencyKey)
        }
        throw new BudgetRequestError(charged.error, idempotencyKey)
      }
      if (!charged.result.allowed) {
        if (charged.result.degraded) {
          throw new BudgetUnavailableError(charged.result.blocked.error, idempotencyKey)
        }
        throw new BudgetExceededError(charged.result, idempotencyKey)
      }
      return await fn(...args)
    }
}

export const createBudgetHandle = (
  budgets: BudgetResources,
  key: string,
  settlement?: SpendSettlement,
  ifMissing?: BudgetDefinitionInput
): BudgetHandle => {
  const creating = ifMissing ? { ifMissing } : {}
  const authorize = async ({
    amount,
    idempotencyKey,
    ...options
  }: AuthorizeBudgetInput): Promise<ApiResult<BudgetAuthorization>> => {
    const response = await budgets.authorize({
      ...options,
      ...creating,
      key,
      amount: toDecimal(amount),
      idempotencyKey,
    })

    if (response.error) {
      const denial = toDenial(response.error)
      return denial ? { result: denial } : { error: response.error }
    }

    return {
      result: {
        allowed: true,
        degraded: false,
        hold: createHold(budgets, key, response.result),
        balance: response.result.balance,
        replayed: response.result.replayed,
        created: response.result.created,
      },
    }
  }

  const charge: BudgetHandle["charge"] = async ({ amount, idempotencyKey }) => {
    const response = await budgets.charge({
      ...creating,
      key,
      amount: toDecimal(amount),
      idempotencyKey,
    })

    if (response.error) {
      const denial = toDenial(response.error)
      return denial ? { result: denial } : { error: response.error }
    }

    return { result: { ...response.result, allowed: true, degraded: false } }
  }

  return {
    key,
    authorize,
    charge,
    record: async ({ amount, ...input }) =>
      budgets.record({ ...input, key, amount: toDecimal(amount) }),
    get: () => budgets.get({ key }),
    spend: createSpend(authorize, settlement),
    wrap: createWrap(charge),
  }
}
