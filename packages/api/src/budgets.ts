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

export type BudgetHold = {
  readonly id: string
  readonly key: string
  readonly amount: string
  readonly expiresAt: number
  /**
   * Safe to retry: the hold id is the idempotency key, so the same amount replays. A hold retires
   * 24 hours after it closes or lapses; after that this returns a 409 instead of counting twice.
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
  amount: AmountInput
  ttlMs?: number
  /** Defaults to a random UUID per call. Pass your own to make the call replayable. */
  idempotencyKey?: string
}

export type ChargeBudgetInput = { amount: AmountInput; idempotencyKey?: string }

/** Usage that already happened. Never denied. Pass the event id so a retry does not count twice. */
export type RecordBudgetInput = { amount: AmountInput; idempotencyKey: string }

export type SpendBudgetInput = { estimate: AmountInput } & Pick<AuthorizeBudgetInput, "ttlMs">

export type BudgetHandle = {
  readonly key: string
  /** A limit denial is `{ allowed: false }`. When Unprice cannot be reached, the denial is `degraded`. */
  authorize(input: AuthorizeBudgetInput): Promise<ApiResult<BudgetAuthorization>>
  charge(input: ChargeBudgetInput): Promise<ApiResult<BudgetCharge>>
  record(input: RecordBudgetInput): Promise<ApiResult<OperationResponse<"budgets.record">>>
  get(): Promise<ApiResult<OperationResponse<"budgets.get">>>
  /**
   * Authorizes the estimate, runs `fn`, and settles the actual it returns. Releases the hold and
   * rethrows when `fn` throws.
   *
   * @throws BudgetExceededError when the budget denies the estimate or cannot be reached.
   * @throws BudgetRequestError when the API rejects the authorization.
   * @throws BudgetSettleError when `fn` succeeded but the settle failed.
   */
  spend<T>(
    input: SpendBudgetInput,
    fn: (hold: BudgetHold) => Promise<{ value: T; actual: AmountInput }>
  ): Promise<T>
}

export class BudgetExceededError extends Error {
  readonly blocked: BudgetBlocked
  readonly balance: BudgetBalance | null

  constructor(denial: BudgetDenial) {
    super(
      denial.blocked.reason === "limit"
        ? `Budget exceeded: limit ${denial.blocked.limitId} (${denial.blocked.remedy})`
        : `Budget unavailable: ${denial.blocked.error.message}`
    )
    this.name = "BudgetExceededError"
    this.blocked = denial.blocked
    this.balance = denial.balance
  }
}

export class BudgetRequestError extends Error {
  constructor(readonly error: ApiError) {
    super(`Budget request failed: ${error.code} ${error.message}`)
    this.name = "BudgetRequestError"
  }
}

/**
 * The work ran and produced `value`, but its usage was not settled. Retry
 * `error.hold.settle({ amount: error.actual })`: the hold id makes the retry safe, while recording
 * the usage separately would count it twice if the first settle did commit. Retry within 24 hours
 * of the hold lapsing; after that the hold is retired and the settle returns a 409.
 */
export class BudgetSettleError extends Error {
  readonly value: unknown
  readonly actual: AmountInput
  readonly hold: BudgetHold
  readonly error: ApiError

  constructor(input: { value: unknown; actual: AmountInput; hold: BudgetHold; error: ApiError }) {
    super(`Settle failed for hold ${input.hold.id}: ${input.error.code} ${input.error.message}`)
    this.name = "BudgetSettleError"
    this.value = input.value
    this.actual = input.actual
    this.hold = input.hold
    this.error = input.error
  }
}

const toDecimal = (amount: AmountInput): string => {
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
const toDenial = (error: ApiError): BudgetDenial | null => {
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

export const createBudgetHandle = (budgets: BudgetResources, key: string): BudgetHandle => {
  const authorize = async ({
    amount,
    idempotencyKey,
    ...options
  }: AuthorizeBudgetInput): Promise<ApiResult<BudgetAuthorization>> => {
    const response = await budgets.authorize({
      ...options,
      key,
      amount: toDecimal(amount),
      idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
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
        idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
      })

      if (response.error) {
        const denial = toDenial(response.error)
        return denial ? { result: denial } : { error: response.error }
      }

      return { result: { ...response.result, allowed: true, degraded: false } }
    },

    record: async ({ amount, idempotencyKey }) =>
      budgets.record({ key, amount: toDecimal(amount), idempotencyKey }),

    get: () => budgets.get({ key }),

    spend: async ({ estimate, ...options }, fn) => {
      const authorized = await authorize({ ...options, amount: estimate })

      if (authorized.error) {
        throw new BudgetRequestError(authorized.error)
      }

      if (!authorized.result.allowed) {
        throw new BudgetExceededError(authorized.result)
      }

      const { hold } = authorized.result
      let outcome: Awaited<ReturnType<typeof fn>>

      try {
        outcome = await fn(hold)
      } catch (error) {
        // A failed release leaves the hold to lapse at its TTL; the caller's error matters more.
        await hold.release()
        throw error
      }

      const settled = await hold.settle({ amount: outcome.actual })

      if (settled.error) {
        throw new BudgetSettleError({
          value: outcome.value,
          actual: outcome.actual,
          hold,
          error: settled.error,
        })
      }

      return outcome.value
    },
  }
}
