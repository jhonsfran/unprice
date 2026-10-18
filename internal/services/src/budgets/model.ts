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
 * - `held` = sum of `amount` over open holds, including expired ones the alarm has not settled yet.
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
 * A hold stays open until it is settled or released, or until `expiresAt` passes: the alarm then
 * settles it at its full amount, because a timer cannot prove the work stopped. Counting all of it
 * keeps the cap, and the capacity returns when the window rolls instead of never.
 * Per state: open counts `amount`; settled consumed `actual` (at most `amount`) and returned the
 * rest; released returned `amount`.
 */
export type HoldState =
  | Readonly<{ status: "open" }>
  | Readonly<{
      status: "settled"
      closedAt: number
      actual: Amount
      crossed: readonly string[]
      /** The alarm settled it at `amount` once `expiresAt` passed; the caller never did. */
      byExpiry?: true
    }>
  | Readonly<{ status: "released"; closedAt: number }>

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
  state: HoldState
}>

/**
 * A charge or record row; its id is `o:<idempotency key>`. The SQLite store keys the row by the
 * key's hash instead.
 */
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
 * What `transition` reads. Only the addressed row and requested window history.
 */
export type BudgetView = Readonly<{
  budget: BudgetRecord | null
  ledger: Ledger
  /**
   * The row this command addresses: by idempotency key for authorize, charge, and record; by hold
   * id for settle and release. Null when it never existed or was purged.
   */
  target: Operation | null
  /** For `get`: up to WINDOW_HISTORY_PERIODS stored periods per limited window id, newest first. */
  history: readonly WindowPeriod[]
  /** For `sweep`: open holds whose `expiresAt` passed, earliest first, a bounded batch. */
  expiredHolds: readonly HoldOperation[]
}>

// Commands

export type BudgetCommand =
  | Readonly<{
      type: "upsert"
      key: string
      projectId: string
      unit: string
      config: BudgetConfig
      /**
       * Whether this caller may loosen an existing budget (`loosening`). Without it, an upsert may
       * create a budget or keep and tighten one, so whoever spends under a cap cannot lift it.
       */
      mayLoosen: boolean
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

/** A limit smaller than the request, or otherwise the failing limit that resets last. */
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
      /** The unused part of the hold, returned: amount - actual. */
      released: Amount
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
  | Readonly<{ type: "sweep" }>

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
  | Readonly<{ code: "WINDOW_CAPACITY_EXCEEDED"; maximum: number; retained: number }>
  | Readonly<{ code: "INVALID_TTL"; ttlMs: number; minTtlMs: number; maxTtlMs: number }>
  | Readonly<{ code: "LIMIT_EXCEEDED"; blocked: Blocked; balance: BudgetBalance }>
  | Readonly<{ code: "HOLD_NOT_FOUND"; holdId: string }>
  | Readonly<{ code: "HOLD_CLOSED"; holdId: string; status: "settled" | "released" | "expired" }>
  | Readonly<{ code: "HOLD_AMOUNT_EXCEEDED"; holdId: string; maximum: Amount; actual: Amount }>
  | Readonly<{ code: "LIMIT_BELOW_USAGE"; limitId: string; minimum: Amount; requested: Amount }>
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
  /** An upsert without `mayLoosen` would let more spend through. */
  | Readonly<{ code: "LOOSENING_FORBIDDEN"; change: ConfigChange }>
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
    case "WINDOW_CAPACITY_EXCEEDED":
      return `Budget retains ${rejection.retained} anchored schedules; at most ${rejection.maximum} can remain active or in their current period`
    case "INVALID_TTL":
      return `Hold TTL must be between ${rejection.minTtlMs} and ${rejection.maxTtlMs} ms, got ${rejection.ttlMs}`
    case "LIMIT_EXCEEDED":
      return `Limit ${rejection.blocked.limitId} has ${formatAmount(rejection.blocked.remaining)} remaining`
    case "HOLD_NOT_FOUND":
      return `Hold ${rejection.holdId} does not exist`
    case "HOLD_CLOSED":
      return rejection.status === "expired"
        ? `Hold ${rejection.holdId} expired and was settled at its full amount`
        : `Hold ${rejection.holdId} is already ${rejection.status}`
    case "HOLD_AMOUNT_EXCEEDED":
      return `Hold ${rejection.holdId} permits ${formatAmount(rejection.maximum)}, not ${formatAmount(rejection.actual)}`
    case "LIMIT_BELOW_USAGE":
      return `Limit ${rejection.limitId} must cover ${formatAmount(rejection.minimum)} consumed or held`
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
    case "LOOSENING_FORBIDDEN":
      return `This caller cannot loosen the budget: the upsert ${describeLoosening(rejection.change)}`
    case "TOO_LATE":
      return `Usage at ${rejection.occurredAt} is older than the oldest accepted ${rejection.oldestAccepted}`
    case "INVALID_OCCURRED_AT":
      return `occurredAt ${rejection.occurredAt} is ahead of the latest accepted ${rejection.latestAccepted}`
  }
}

function describeLoosening(change: ConfigChange): string {
  switch (change.change) {
    case "limit.removed":
      return `removes hard limit ${change.limitId}`
    case "limit.amount":
      return `raises hard limit ${change.limitId} from ${formatAmount(change.from)} to ${formatAmount(change.to)}`
    case "limit.enforce":
      return `makes hard limit ${change.limitId} ${change.to}`
    default:
      return "clears or postpones closesAt"
  }
}

export function reject(rejection: BudgetRejection): Result<never, UnPriceBudgetError> {
  return Err(new UnPriceBudgetError(rejection))
}
