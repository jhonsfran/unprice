/**
 * The budget's data model: the ledger, operation rows, commands, outcomes, and rejections.
 * Types only, plus the error a rejection travels in.
 */

import { BaseError, Err, type Result } from "@unprice/error"
import { type Amount, type SignedAmount, formatAmount } from "@unprice/money"
import type { BudgetConfig, BudgetLimit, BudgetRecord, ConfigChange } from "./config"
import type { AnchoredWindowId, BudgetWindow, WindowId } from "./windows"

const ZERO = BigInt(0)

// Projections

/** One usage counter: consumption since `start`, the start of the period it is in. */
export type WindowUsage = Readonly<{ start: number; consumed: Amount }>

/**
 * The five calendar counters always, and one per anchored window id a limit references. An
 * anchored counter no limit references any more stays until its period ends, so removing and
 * re-adding a limit inside one period never resets it.
 */
export type WindowCounters = Readonly<
  Record<BudgetWindow, WindowUsage> & Partial<Record<AnchoredWindowId, WindowUsage>>
>

/** A period of one window that ended with usage: the payload of `window.rolled`. */
export type WindowPeriod = Readonly<{
  windowId: WindowId
  start: number
  end: number
  consumed: Amount
}>
/**
 * The aggregate and the authoritative balance: one row, rewritten by every accepted command, O(1)
 * in history.
 * - `lastAt` is the budget's clock: when it last wrote. `transition` clamps to it, so windows only
 *   roll forward and nothing is purged ahead of a later command's clock.
 * - `holdSeq` counts holds ever placed. `h_<n>` with n <= holdSeq was minted.
 * - `held` = sum of `amount` over open holds (including expired ones not yet lapsed).
 * - `usage` has all five canonical windows plus anchored ones; `usage.never.consumed` is lifetime
 *   consumption. Every consumption adds to every counter.
 */
export type Ledger = Readonly<{
  lastAt: number
  holdSeq: number
  held: Amount
  usage: WindowCounters
}>

export const emptyLedger: Ledger = {
  lastAt: 0,
  holdSeq: 0,
  held: ZERO,
  usage: {
    hour: { start: 0, consumed: ZERO },
    day: { start: 0, consumed: ZERO },
    week: { start: 0, consumed: ZERO },
    month: { start: 0, consumed: ZERO },
    never: { start: 0, consumed: ZERO },
  },
}

/**
 * A hold is open until it is settled, released, or lapses. "Expired" is not a stored state: it is
 * `now >= expiresAt` on an open hold, which still counts and still settles normally.
 * Per state: open counts `amount`; lapsed returned `amount`; settled has covered + released =
 * amount (both 0 when late, because the lapse already returned it); released returned `released`.
 */
export type HoldState =
  | Readonly<{ status: "open" }>
  | Readonly<{ status: "lapsed"; lapsedAt: number }>
  | Readonly<{
      status: "settled"
      closedAt: number
      actual: Amount
      /** Consumed out of the hold. */
      covered: Amount
      /** Returned to capacity by this settle (0 when late, because the lapse already returned it). */
      released: Amount
      /** Consumed beyond the hold: actual - covered. */
      overrun: Amount
      late: boolean
      crossed: readonly string[]
    }>
  | Readonly<{ status: "released"; closedAt: number; released: Amount }>

/**
 * Operation rows are the idempotency record: the same key with the same request replays from the
 * row, and with another request conflicts.
 */
export type HoldOperation = Readonly<{
  kind: "hold"
  id: string
  idempotencyKey: string
  amount: Amount
  /** As requested; null took the budget's default, so a retry must omit it too. */
  ttlMs: number | null
  createdAt: number
  expiresAt: number
  lapsesAt: number
  state: HoldState
}>

/** A charge or record row; its id is `o:<idempotency key>`. */
export type ChargeOperation = Readonly<{
  kind: "charge" | "record"
  id: string
  idempotencyKey: string
  amount: Amount
  createdAt: number
  crossed: readonly string[]
}>

export type Operation = HoldOperation | ChargeOperation

/**
 * What `transition` reads. Never the full history: only the row the command addresses and the
 * open holds the store found due.
 */
export type BudgetView = Readonly<{
  budget: BudgetRecord | null
  ledger: Ledger
  /**
   * The row this command addresses: by idempotency key for authorize, charge, and record; by hold
   * id for settle and release. Null when it never existed or was purged.
   */
  target: Operation | null
  /** Open holds with `lapsesAt <= max(clock, ledger.lastAt)`, any subset; the alarm sweeps the rest. */
  due: readonly HoldOperation[]
  /** For `get`: up to WINDOW_HISTORY_PERIODS stored periods per limited window id, newest first. */
  history: readonly WindowPeriod[]
}>

// Commands

export type BudgetCommand =
  | Readonly<{
      type: "upsert"
      key: string
      projectId: string
      unit: string
      config: BudgetConfig
    }>
  | Readonly<{ type: "authorize"; idempotencyKey: string; amount: Amount; ttlMs?: number }>
  | Readonly<{ type: "settle"; holdId: string; amount: Amount }>
  | Readonly<{ type: "release"; holdId: string }>
  | Readonly<{ type: "charge"; idempotencyKey: string; amount: Amount }>
  | Readonly<{
      type: "record"
      idempotencyKey: string
      amount: Amount
      /** Epoch ms the usage happened. Bounds acceptance only; usage counts when it arrives. */
      occurredAt: number
    }>
  | Readonly<{ type: "get" }>
  | Readonly<{ type: "sweep" }>

// Outcomes

export type LimitBalance = Readonly<{
  id: string
  window: BudgetWindow
  enforce: BudgetLimit["enforce"]
  amount: Amount
  consumed: Amount
  held: Amount
  remaining: SignedAmount
  /** Start of the next window; null for "never". */
  resetsAt: number | null
}>

export type BudgetBalance = Readonly<{
  /** Minimum over hard limits; null when the budget has no hard limit. */
  remaining: SignedAmount | null
  held: Amount
  limits: readonly LimitBalance[]
  asOf: number
}>

export type BudgetSnapshot = Readonly<
  {
    key: string
    unit: string
    version: number
    /** `closesAt` has passed (B1). */
    closed: boolean
    balance: BudgetBalance
  } & BudgetConfig
>

/** What would let the same request through. */
export type BlockedRemedy = "release_holds" | "wait_for_reset" | "raise_limit"

/** The blocking limit: among failing hard limits, the one that resets last. */
export type Blocked = Readonly<{
  limitId: string
  window: BudgetWindow
  remaining: SignedAmount
  held: Amount
  resetsAt: number | null
  remedy: BlockedRemedy
}>

export type BudgetOutcome =
  | Readonly<{ type: "upsert"; changes: readonly ConfigChange[]; budget: BudgetSnapshot }>
  | Readonly<{ type: "get"; budget: BudgetSnapshot; history: readonly WindowPeriod[] }>
  | Readonly<{
      type: "authorize"
      holdId: string
      amount: Amount
      expiresAt: number
      replayed: boolean
      balance: BudgetBalance
    }>
  | Readonly<{
      type: "settle"
      holdId: string
      actual: Amount
      covered: Amount
      released: Amount
      overrun: Amount
      /** The hold had lapsed before this settle; nothing was covered. */
      late: boolean
      /** Settled at or after `expiresAt`. */
      expired: boolean
      crossed: readonly string[]
      replayed: boolean
      balance: BudgetBalance
    }>
  | Readonly<{
      type: "release"
      holdId: string
      released: Amount
      replayed: boolean
      balance: BudgetBalance
    }>
  | Readonly<{
      type: "charge" | "record"
      amount: Amount
      crossed: readonly string[]
      replayed: boolean
      balance: BudgetBalance
    }>
  | Readonly<{ type: "sweep"; lapsed: number }>

/** The outcome a command of type `T` answers with. */
export type OutcomeOf<T extends BudgetOutcome["type"]> = BudgetOutcome & Readonly<{ type: T }>

/** Every command answers with the outcome of its own type. */
export function isOutcomeOf<T extends BudgetOutcome["type"]>(
  outcome: BudgetOutcome,
  type: T
): outcome is OutcomeOf<T> {
  return outcome.type === type
}

// Rejections

export type BudgetRejection =
  | Readonly<{ code: "BUDGET_NOT_FOUND" }>
  | Readonly<{ code: "INVALID_TTL"; ttlMs: number; minTtlMs: number; maxTtlMs: number }>
  | Readonly<{ code: "LIMIT_EXCEEDED"; blocked: Blocked; balance: BudgetBalance }>
  | Readonly<{ code: "HOLD_NOT_FOUND"; holdId: string }>
  | Readonly<{ code: "HOLD_CLOSED"; holdId: string; status: "settled" | "released" }>
  /** Minted, but its row was purged after retention, so its outcome is no longer known. */
  | Readonly<{ code: "HOLD_RETIRED"; holdId: string }>
  | Readonly<{ code: "IDEMPOTENCY_CONFLICT"; idempotencyKey: string }>
  | Readonly<{ code: "UNIT_IMMUTABLE"; current: string; requested: string }>
  /** A limit id names its window id for good: moving it would restart the count at zero. */
  | Readonly<{
      code: "LIMIT_WINDOW_IMMUTABLE"
      limitId: string
      current: WindowId
      requested: WindowId
    }>
  /** Authorize and charge from `closesAt` on; record from `closesAt + OPERATION_RETENTION_MS`. */
  | Readonly<{ code: "BUDGET_CLOSED"; closedAt: number }>
  | Readonly<{ code: "TOO_LATE"; occurredAt: number; oldestAccepted: number }>
  | Readonly<{ code: "INVALID_OCCURRED_AT"; occurredAt: number; latestAccepted: number }>

export type BudgetErrorCode = BudgetRejection["code"]

/** An expected budget failure. `rejection` is plain data and is what crosses an RPC boundary. */
export class UnPriceBudgetError extends BaseError<{ code: BudgetErrorCode }> {
  public readonly retry = false
  public readonly name = "UnPriceBudgetError"
  public readonly code: BudgetErrorCode

  constructor(public readonly rejection: BudgetRejection) {
    super({ message: rejectionMessage(rejection), context: { code: rejection.code } })
    this.code = rejection.code
  }
}

function rejectionMessage(rejection: BudgetRejection): string {
  switch (rejection.code) {
    case "BUDGET_NOT_FOUND":
      return "Budget does not exist"
    case "INVALID_TTL":
      return `Hold TTL must be between ${rejection.minTtlMs} and ${rejection.maxTtlMs} ms, got ${rejection.ttlMs}`
    case "LIMIT_EXCEEDED":
      return `Limit ${rejection.blocked.limitId} has ${formatAmount(rejection.blocked.remaining)} remaining`
    case "HOLD_NOT_FOUND":
      return `Hold ${rejection.holdId} does not exist`
    case "HOLD_CLOSED":
      return `Hold ${rejection.holdId} is already ${rejection.status}`
    case "HOLD_RETIRED":
      return `Hold ${rejection.holdId} closed past its retention and can no longer be settled or released`
    case "IDEMPOTENCY_CONFLICT":
      return `Idempotency key ${rejection.idempotencyKey} was used with a different request`
    case "UNIT_IMMUTABLE":
      return `Budget unit is ${rejection.current} and cannot change to ${rejection.requested}`
    case "LIMIT_WINDOW_IMMUTABLE":
      return `Limit ${rejection.limitId} counts over ${rejection.current} and cannot change to ${rejection.requested}; add a limit with a new id instead`
    case "BUDGET_CLOSED":
      return `Budget closed at ${new Date(rejection.closedAt).toISOString()}`
    case "TOO_LATE":
      return `Usage at ${rejection.occurredAt} is older than the oldest accepted ${rejection.oldestAccepted}`
    case "INVALID_OCCURRED_AT":
      return `occurredAt ${rejection.occurredAt} is ahead of the latest accepted ${rejection.latestAccepted}`
  }
}

export function reject(rejection: BudgetRejection): Result<never, UnPriceBudgetError> {
  return Err(new UnPriceBudgetError(rejection))
}
