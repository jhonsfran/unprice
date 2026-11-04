/**
 * The budget's data model: the ledger, operation rows, commands, outcomes, and rejections.
 * Types only, plus the error a rejection travels in.
 */

import { BaseError, Err, type Result } from "@unprice/error"
import { type Amount, type SignedAmount, formatAmount } from "@unprice/money"
import type {
  BudgetConfig,
  BudgetLimit,
  BudgetOperations,
  BudgetRecord,
  ConfigChange,
} from "./config"
import { type BudgetMeasure, NO_USAGE, type Usage, measureName } from "./usage"
import type { AnchoredWindowId, BudgetWindow, WindowId } from "./windows"

// Projections

/** One usage counter: consumption since `start`, the start of the period it is in. */
export type WindowUsage = Readonly<{ start: number; consumed: Usage }>

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
  consumed: Usage
}>
/**
 * The aggregate and the authoritative balance: one row, rewritten by every accepted command, O(1)
 * in history.
 * - `lastAt` is the budget's clock: when it last wrote. `transition` clamps to it, so windows only
 *   roll forward and nothing is purged ahead of a later command's clock.
 * - `holdSeq` counts holds ever placed. `h_<n>` with n <= holdSeq was minted.
 * - `held` = what open reservations count: each open hold's `reserved` and each open lease's
 *   `granted - captured` (an amount), including expired ones the alarm has not closed yet.
 * - `usage` has all five canonical windows plus anchored ones; `usage.never.consumed` is lifetime
 *   consumption. Every consumption adds its whole vector to every counter.
 * - `operations` counts the accepted calls that changed the budget, per verb. It rides on the row
 *   every such call rewrites anyway, so counting costs no write.
 */
export type Ledger = Readonly<{
  lastAt: number
  holdSeq: number
  held: Usage
  usage: WindowCounters
  operations: BudgetOperations
}>

export const emptyLedger: Ledger = {
  lastAt: 0,
  holdSeq: 0,
  held: NO_USAGE,
  usage: {
    hour: { start: 0, consumed: NO_USAGE },
    day: { start: 0, consumed: NO_USAGE },
    week: { start: 0, consumed: NO_USAGE },
    month: { start: 0, consumed: NO_USAGE },
    never: { start: 0, consumed: NO_USAGE },
  },
  operations: {
    upsert: 0,
    authorize: 0,
    settle: 0,
    release: 0,
    charge: 0,
    record: 0,
    lease: 0,
    report: 0,
  },
}

/**
 * A hold stays open until it is settled or released, or until `expiresAt` passes: the alarm then
 * settles it at all it reserved, because a timer cannot prove the work stopped. Counting all of it
 * keeps the cap, and the capacity returns when the window rolls instead of never.
 * Per state: open counts `reserved`; settled consumed `actual` (at most `reserved` on every
 * measure) and returned the rest; released returned `reserved`.
 */
export type HoldState =
  | Readonly<{ status: "open" }>
  | Readonly<{
      status: "settled"
      closedAt: number
      actual: Usage
      crossed: readonly string[]
      /** The alarm settled it at `reserved` once `expiresAt` passed; the caller never did. */
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
  reserved: Usage
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
  usage: Usage
  createdAt: number
  crossed: readonly string[]
}>

/**
 * What one lease report asks for. `captured` is cumulative, so a lost report is subsumed by the
 * next. A final report closes the lease, so it cannot extend it. A retry of the same seq must
 * repeat it field by field.
 */
export type LeaseReportRequest =
  | Readonly<{ final: false; captured: Amount; extend: Amount }>
  | Readonly<{ final: true; captured: Amount }>

/** Why an extension came back short. The capture in the same report still applied. */
export type ExtensionDenial =
  | Readonly<{ code: "LIMIT_EXCEEDED"; blocked: Blocked }>
  | Readonly<{ code: "BUDGET_CLOSED"; closedAt: number }>

/** The last report a lease applied and what it produced, so an exact retry replays it. */
export type AppliedReport = Readonly<{
  seq: number
  request: LeaseReportRequest
  extended: Amount
  denied: ExtensionDenial | null
  crossed: readonly string[]
}>

/**
 * open counts `granted - captured` against every limit. closed consumed `captured` and returned
 * the rest. expired consumed all of `granted`: a timer cannot prove the process stopped (B3, B10).
 * refused granted nothing because nothing fit; it keeps what blocked it, so a later copy of the
 * request replays the refusal instead of taking capacity no process holds.
 */
export type LeaseState =
  | Readonly<{ status: "open" }>
  | Readonly<{ status: "closed"; closedAt: number }>
  | Readonly<{ status: "expired"; closedAt: number }>
  | Readonly<{ status: "refused"; closedAt: number; blocked: Blocked }>

/**
 * Capacity debited up front for a process to spend in its own memory (B10 `local`). Amounts only:
 * a lease reserves and consumes the amount measure, and quantity limits ignore it. Its id is
 * `l:<lease key>`; the SQLite store keys the row by the key's hash instead. `granted` and
 * `captured` only grow, and `captured <= granted`. Its seq is `last?.seq ?? 0`.
 */
export type LeaseOperation = Readonly<{
  kind: "lease"
  id: string
  /** Chosen by the SDK, one per lease. A separate namespace from idempotency keys. */
  leaseKey: string
  /** As requested at grant; a grant retry must repeat it and `ttlMs`. */
  requested: Amount
  /** The renewal period. */
  ttlMs: number
  createdAt: number
  granted: Amount
  captured: Amount
  last: AppliedReport | null
  expiresAt: number
  state: LeaseState
}>

export type Operation = HoldOperation | ChargeOperation | LeaseOperation

/** Rows that reserve capacity while open, and that the alarm closes into consumption at expiry. */
export type ReservationOperation = HoldOperation | LeaseOperation

/**
 * What `transition` reads. Only the addressed row and requested window history.
 */
export type BudgetView = Readonly<{
  budget: BudgetRecord | null
  ledger: Ledger
  /**
   * The row this command addresses: by idempotency key for authorize, charge, and record; by hold
   * id for settle and release; by lease key for lease and report. Null when it never existed or
   * was purged.
   */
  target: Operation | null
  /** For `get`: up to WINDOW_HISTORY_PERIODS stored periods per limited window id, newest first. */
  history: readonly WindowPeriod[]
  /** For `sweep`: open holds and leases whose `expiresAt` passed, earliest first, a bounded batch. */
  expired: readonly ReservationOperation[]
}>

// Commands

/**
 * The budget a keyed verb creates when its key has none (ADR-0006 D8): the upsert a runtime key
 * would send, at the address the verb is sent to. An existing budget ignores it.
 */
export type BudgetDefinition = Readonly<{
  key: string
  projectId: string
  unit: string
  config: BudgetConfig
}>

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
  | Readonly<{
      type: "authorize"
      idempotencyKey: string
      /** The most the work may consume, on every measure. */
      usage: Usage
      ttlMs?: number
      ifMissing?: BudgetDefinition
    }>
  | Readonly<{ type: "settle"; holdId: string; actual: Usage }>
  | Readonly<{ type: "release"; holdId: string; holdCreatedAt?: number }>
  | Readonly<{
      type: "charge"
      idempotencyKey: string
      usage: Usage
      ifMissing?: BudgetDefinition
    }>
  | Readonly<{
      type: "record"
      idempotencyKey: string
      usage: Usage
      /** Epoch ms the usage happened. Bounds acceptance only; usage counts when it arrives. */
      occurredAt: number
    }>
  /** Debits `min(amount, room)` under every hard amount limit for a process to spend locally. */
  | Readonly<{
      type: "lease"
      leaseKey: string
      amount: Amount
      ttlMs: number
      ifMissing?: BudgetDefinition
    }>
  | Readonly<{ type: "report"; leaseKey: string; seq: number; request: LeaseReportRequest }>
  | Readonly<{ type: "get" }>
  | Readonly<{ type: "sweep" }>

// Outcomes

/** One limit at the clock; every number is on the limit's own measure. */
export type LimitBalance = Readonly<{
  id: string
  window: BudgetWindow
  enforce: BudgetLimit["enforce"]
  measure: BudgetMeasure
  amount: Amount
  consumed: Amount
  held: Amount
  remaining: SignedAmount
  /** Start of the next window; null for "never". */
  resetsAt: number | null
}>

export type BudgetBalance = Readonly<{
  /** Minimum over hard amount limits; null when the budget has none. */
  remaining: SignedAmount | null
  held: Usage
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
    operations: BudgetOperations
  } & BudgetConfig
>

/** A granted lease; a refused one answers with the LIMIT_EXCEEDED rejection instead. */
export type LeaseView = Readonly<{
  leaseKey: string
  seq: number
  granted: Amount
  captured: Amount
  expiresAt: number
  status: Exclude<LeaseState["status"], "refused">
}>

/** What a local handle needs to answer like the budget: hold TTL bounds and the close time. */
export type LeaseTerms = Readonly<Pick<BudgetConfig, "holds" | "closesAt">>

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
      reserved: Usage
      expiresAt: number
      replayed: boolean
      balance: BudgetBalance
      /** The budget this verb created from its `ifMissing`; null when it already existed. */
      created: BudgetSnapshot | null
    }>
  | Readonly<{
      type: "settle"
      holdId: string
      actual: Usage
      /** The unused part of the hold, returned: reserved - actual. */
      released: Usage
      /** Settled at or after `expiresAt`. */
      expired: boolean
      crossed: readonly string[]
      replayed: boolean
      balance: BudgetBalance
    }>
  | Readonly<{
      type: "release"
      holdId: string
      released: Usage
      replayed: boolean
      balance: BudgetBalance
    }>
  | Readonly<{
      type: "charge" | "record"
      usage: Usage
      crossed: readonly string[]
      replayed: boolean
      balance: BudgetBalance
      /** The budget a charge created from its `ifMissing`; null otherwise, always for a record. */
      created: BudgetSnapshot | null
    }>
  | Readonly<{
      type: "lease"
      /** The budget this lease created from its `ifMissing`; null when it already existed. */
      created: BudgetSnapshot | null
      lease: LeaseView
      terms: LeaseTerms
      replayed: boolean
      balance: BudgetBalance
    }>
  | Readonly<{
      type: "report"
      lease: LeaseView
      terms: LeaseTerms
      extension: Readonly<{ requested: Amount; granted: Amount; denied: ExtensionDenial | null }>
      /** A final report's unused grant, returned: granted - captured. Zero otherwise. */
      released: Amount
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
  /** `actual` passes the hold on `measure`; both numbers are on that measure. */
  | Readonly<{
      code: "HOLD_AMOUNT_EXCEEDED"
      holdId: string
      measure: BudgetMeasure
      maximum: Amount
      actual: Amount
    }>
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
  /** A limit id names its measure for good: moving it would drop the cap it enforced. */
  | Readonly<{
      code: "LIMIT_MEASURE_IMMUTABLE"
      limitId: string
      current: BudgetMeasure
      requested: BudgetMeasure
    }>
  /** Authorize and charge from `closesAt` on; record from `closesAt + OPERATION_RETENTION_MS`. */
  | Readonly<{ code: "BUDGET_CLOSED"; closedAt: number }>
  /** An upsert without `mayLoosen` would let more spend through. */
  | Readonly<{ code: "LOOSENING_FORBIDDEN"; change: ConfigChange }>
  | Readonly<{ code: "TOO_LATE"; occurredAt: number; oldestAccepted: number }>
  | Readonly<{ code: "INVALID_OCCURRED_AT"; occurredAt: number; latestAccepted: number }>
  /** Never granted, or purged after retention. */
  | Readonly<{ code: "LEASE_NOT_FOUND"; leaseKey: string }>
  | Readonly<{ code: "LEASE_CLOSED"; leaseKey: string; status: "closed" | "expired" }>
  /** `seq` is the last applied: only `seq + 1`, or an exact retry of `seq`, is accepted. */
  | Readonly<{ code: "LEASE_SEQ_CONFLICT"; leaseKey: string; seq: number; requested: number }>
  | Readonly<{
      code: "LEASE_CAPTURE_OUT_OF_RANGE"
      leaseKey: string
      minimum: Amount
      maximum: Amount
      captured: Amount
    }>

export type BudgetErrorCode = BudgetRejection["code"]

/**
 * What a command answers. Error classes do not survive Workers RPC, so a rejection is plain data.
 */
export type BudgetReply =
  | Readonly<{ ok: true; outcome: BudgetOutcome }>
  | Readonly<{ ok: false; rejection: BudgetRejection }>

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
    case "HOLD_AMOUNT_EXCEEDED": {
      const { measure } = rejection
      const of = measure.type === "amount" ? "" : ` of ${measureName(measure)}`
      return `Hold ${rejection.holdId} permits ${formatAmount(rejection.maximum)}${of}, not ${formatAmount(rejection.actual)}`
    }
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
    case "LIMIT_MEASURE_IMMUTABLE":
      return `Limit ${rejection.limitId} caps ${measureName(rejection.current)} and cannot change to ${measureName(rejection.requested)}; add a limit with a new id instead`
    case "BUDGET_CLOSED":
      return `Budget closed at ${new Date(rejection.closedAt).toISOString()}`
    case "LOOSENING_FORBIDDEN":
      return `This caller cannot loosen the budget: the upsert ${describeLoosening(rejection.change)}`
    case "TOO_LATE":
      return `Usage at ${rejection.occurredAt} is older than the oldest accepted ${rejection.oldestAccepted}`
    case "INVALID_OCCURRED_AT":
      return `occurredAt ${rejection.occurredAt} is ahead of the latest accepted ${rejection.latestAccepted}`
    case "LEASE_NOT_FOUND":
      return `Lease ${rejection.leaseKey} does not exist`
    case "LEASE_CLOSED":
      return rejection.status === "expired"
        ? `Lease ${rejection.leaseKey} expired; a final report is accepted only until the alarm counts its remainder`
        : `Lease ${rejection.leaseKey} is already closed`
    case "LEASE_SEQ_CONFLICT":
      return `Lease ${rejection.leaseKey} applied report ${rejection.seq}; expected ${rejection.seq + 1} or an exact retry of ${rejection.seq}, got ${rejection.requested}`
    case "LEASE_CAPTURE_OUT_OF_RANGE":
      return `Lease ${rejection.leaseKey} accepts a cumulative capture from ${formatAmount(rejection.minimum)} to ${formatAmount(rejection.maximum)}, not ${formatAmount(rejection.captured)}`
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
