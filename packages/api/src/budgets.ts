import type { UnpriceOptions } from "./client"
import type { ApiError, ErrorResponse } from "./errors"
import type { GeneratedSdkResources } from "./generated/sdk-resources"
import type { OperationResponse } from "./operation-types"
import type { ApiResult } from "./result"

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

export type BudgetAuthorization =
  | { allowed: true; degraded: false; hold: BudgetHold; balance: BudgetBalance; replayed: boolean }
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
 * limit it passed; authorize before work that needs guaranteed capacity. Within 8 days, the same
 * event key and amount replay; another amount is 409.
 */
export type RecordBudgetInput = {
  amount: AmountInput
  idempotencyKey: string
  /**
   * When the usage happened, in epoch ms: the event's own time, never the time of the call. Usage
   * older than 7 days is refused (409), which is what stops a retry from counting twice once its
   * key's 8-day dedupe has ended, so a retry must send the same time.
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
 * Unprice could not be reached, so nothing ran. The authorization may still have committed:
 * retry with the same estimate, TTL, and `idempotencyKey` so it replays instead of holding twice.
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
 * Do not release or record separately. The first settle may have committed, and excess usage
 * must not be hidden. A closed hold retains its replay result for 24 hours.
 */
export class BudgetSettleError extends Error {
  readonly value: unknown
  readonly actual: AmountInput
  readonly hold: BudgetHold
  readonly error: ApiError | undefined
  readonly idempotencyKey: string

  constructor(
    input: {
      value: unknown
      actual: AmountInput
      hold: BudgetHold
      idempotencyKey: string
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

export const createBudgetHandle = (
  budgets: BudgetResources,
  key: string,
  settlement?: SpendSettlement
): BudgetHandle => {
  const authorize = async ({
    amount,
    idempotencyKey,
    ...options
  }: AuthorizeBudgetInput): Promise<ApiResult<BudgetAuthorization>> => {
    const response = await budgets.authorize({
      ...options,
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
      },
    }
  }

  return {
    key,
    authorize,

    charge: async ({ amount, idempotencyKey }) => {
      const response = await budgets.charge({
        key,
        amount: toDecimal(amount),
        idempotencyKey,
      })

      if (response.error) {
        const denial = toDenial(response.error)
        return denial ? { result: denial } : { error: response.error }
      }

      return { result: { ...response.result, allowed: true, degraded: false } }
    },

    record: async ({ amount, ...input }) =>
      budgets.record({ ...input, key, amount: toDecimal(amount) }),

    get: () => budgets.get({ key }),

    spend: createSpend(authorize, settlement),
  }
}
