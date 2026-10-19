/**
 * Pure budget core (ADR-0006 B1-B3, B7). No clock, no I/O.
 *
 * `decide` owns every policy rule and returns the change a command makes, or a rejection.
 * `transition` rolls ended windows, decides, applies the change to the ledger, and checks
 * conservation. A store keeps what it returns in one transaction: the ledger (one row, the
 * authoritative balance), one row per operation (open hold, closed tombstone, idempotency
 * record), and the window history.
 */

import { Err, Ok, type Result } from "@unprice/error"
import {
  type BudgetOperations,
  type BudgetRecord,
  type ConfigChange,
  WINDOW_HISTORY_PERIODS,
  deletableAt,
  isClosed,
} from "./config"
import { type Change, balanceOf, decide, holdNumber } from "./decide"
import { type RowStep, checkTransition } from "./invariants"
import { alarmAt, consume, dueAt, rollUsage, trackLimits } from "./ledger"
import type {
  BudgetBalance,
  BudgetCommand,
  BudgetOutcome,
  BudgetView,
  LeaseOperation,
  LeaseView,
  Ledger,
  Operation,
  ReservationOperation,
  UnPriceBudgetError,
  WindowPeriod,
} from "./model"
import { type WindowId, windowIdOf } from "./windows"

const ZERO = BigInt(0)

/** The reads a store answers inside its transaction. Rows come back as domain types. */
export type BudgetReader = {
  readBudget(): BudgetRecord | null
  readLedger(): Ledger
  readOperation(id: string): Operation | null
  readOperationByKey(idempotencyKey: string): Operation | null
  /** The lease with this key, or null when it never existed or was purged. */
  readLease(leaseKey: string): LeaseOperation | null
  /** Up to `limit` stored periods of each window id, newest first. */
  readHistory(windowIds: readonly WindowId[], limit: number): WindowPeriod[]
  /**
   * Up to `limit` open holds and leases with `expiresAt <= now`, by `expiresAt`, then holds before
   * leases, holds by number.
   */
  readExpired(now: number, limit: number): ReservationOperation[]
}

/** The most expired reservations one sweep closes; the alarm comes back at once for the rest. */
export const EXPIRED_PER_SWEEP = 256

/**
 * Loads the addressed operation, the history a `get` returns, and the expired reservations a
 * `sweep` closes at the clock `transition` will clamp to.
 */
export function loadView(
  reader: BudgetReader,
  command: BudgetCommand,
  clockMs: number
): BudgetView {
  const ledger = reader.readLedger()
  const budget = reader.readBudget()
  const now = Math.max(clockMs, ledger.lastAt)
  return {
    budget,
    ledger,
    target: targetOf(reader, command),
    history:
      command.type === "get" && budget
        ? reader.readHistory(limitedWindows(budget), WINDOW_HISTORY_PERIODS)
        : [],
    expired: command.type === "sweep" && budget ? reader.readExpired(now, EXPIRED_PER_SWEEP) : [],
  }
}

/** Window ids the budget's limits use, once each, in limit order. */
function limitedWindows(budget: BudgetRecord): WindowId[] {
  return [...new Set(budget.config.limits.map((limit) => windowIdOf(limit)))]
}

function targetOf(reader: BudgetReader, command: BudgetCommand): Operation | null {
  switch (command.type) {
    case "authorize":
    case "charge":
    case "record":
      return reader.readOperationByKey(command.idempotencyKey)
    case "settle":
    case "release":
      return reader.readOperation(command.holdId)
    case "lease":
    case "report":
      return reader.readLease(command.leaseKey)
    default:
      return null
  }
}

export type BudgetTransition = Readonly<{
  /** The clamped clock; the written ledger's `lastAt`. */
  now: number
  /** False for a read or a replay: the store writes nothing. */
  write: boolean
  /** The new config to write, or null when it did not change. */
  budget: BudgetRecord | null
  ledger: Ledger
  /** A row past its retention whose key this command reuses; the store deletes it first. */
  purged: readonly Operation[]
  /** Rows created or changed; the store upserts exactly these. */
  operations: readonly Operation[]
  /** Ended periods to add to the window history. */
  periods: readonly WindowPeriod[]
  /** Anchored schedules whose inactive current period ended. */
  retiredWindows: readonly WindowId[]
  outcome: BudgetOutcome
  /**
   * Earliest `alarmAt` among the written rows, and a new config's `deletableAt`; the store only
   * ever lowers its alarm to it. A window boundary needs no wake: a counter keeps its period's
   * start, so the next command rolls it the same however late it comes.
   */
  wakeAt: number | null
}>

/**
 * Clamps the clock, rolls ended windows, decides, applies and checks the change.
 * A rejection writes nothing. An invariant failure throws and must abort the transaction.
 */
export function transition(params: {
  view: BudgetView
  command: BudgetCommand
  clockMs: number
}): Result<BudgetTransition, UnPriceBudgetError> {
  const { view, command, clockMs } = params
  if (!Number.isSafeInteger(clockMs)) throw new Error(`clock ${clockMs} is not an integer`)
  const now = Math.max(clockMs, view.ledger.lastAt)

  // A closed row answers only until its retention ends, however late the alarm purges it.
  const pastRetention = view.target && isPastRetention(view.target, now) ? view.target : null
  const live = pastRetention ? null : view.target
  const limits = view.budget?.config.limits ?? []
  const rolled = rollUsage(view.ledger.usage, now, limits)
  const rolledLedger: Ledger = { ...view.ledger, usage: rolled.usage }

  const decided = decide(
    command,
    { budget: view.budget, ledger: rolledLedger, target: live, expired: view.expired },
    now
  )
  if (decided.err) return Err(decided.err)
  const change = decided.val

  const budget = change.configured?.budget ?? view.budget
  const usage = change.configured
    ? trackLimits(rolledLedger.usage, change.configured.budget.config.limits, now)
    : rolledLedger.usage
  const ledger: Ledger = {
    lastAt: now,
    holdSeq: change.rows.reduce(
      (seq, row) => (row.kind === "hold" ? Math.max(seq, holdNumber(row.id)) : seq),
      rolledLedger.holdSeq
    ),
    held: rolledLedger.held + change.held,
    usage: consume(usage, change.consumed),
    operations: countCall(rolledLedger.operations, command, change),
  }
  const operations = change.rows
  const { periods } = rolled
  // A row changes from the addressed one, or from an expired reservation a sweep closes; else it
  // is new.
  const priors = new Map<string, Operation>(view.expired.map((row) => [row.id, row]))
  if (live) priors.set(live.id, live)

  const violations = checkTransition({
    before: view.ledger,
    after: ledger,
    limits,
    resultingLimits: budget?.config.limits ?? [],
    steps: change.rows.map((row): RowStep => [priors.get(row.id), row]),
    periods,
  })
  if (violations.length > 0) {
    throw new Error(`budget transition breaks invariants: ${violations.join("; ")}`)
  }

  let wakeAt = change.configured ? deletableAt(change.configured.budget.config) : null
  for (const operation of operations) {
    const due = alarmAt(operation)
    if (wakeAt === null || due < wakeAt) wakeAt = due
  }
  // A sweep always moves the budget's clock to now, so the purge after it never runs ahead of a
  // later command's clamped clock.
  const write =
    budget !== null &&
    (operations.length > 0 ||
      periods.length > 0 ||
      rolled.retired.length > 0 ||
      change.configured !== undefined ||
      command.type === "sweep")

  return Ok({
    now,
    write,
    budget: change.configured?.budget ?? null,
    ledger,
    purged: pastRetention && change.rows.length > 0 ? [pastRetention] : [],
    operations,
    periods,
    retiredWindows: rolled.retired,
    outcome: outcomeOf(command, {
      budget,
      ledger,
      row: change.row,
      replayed: change.rows.length === 0,
      changes: change.configured?.changes ?? [],
      history: [...periods, ...view.history],
      now,
    }),
    wakeAt,
  })
}

/**
 * Counts a caller's command that changed the budget. A replay, an upsert that changed nothing, a
 * refused lease (written only so its key stays refused), and the alarm's sweep (which closes
 * expired reservations) are not counted.
 */
function countCall(
  operations: BudgetOperations,
  command: BudgetCommand,
  change: Pick<Change, "rows" | "configured" | "row">
): BudgetOperations {
  if (command.type === "get" || command.type === "sweep") return operations
  if (change.rows.length === 0 && change.configured === undefined) return operations
  if (change.row?.kind === "lease" && change.row.state.status === "refused") return operations
  return { ...operations, [command.type]: operations[command.type] + 1 }
}

/** Past its retention. An open hold or lease has none until it is closed. */
function isPastRetention(row: Operation, now: number): boolean {
  const due = dueAt(row)
  return due !== null && due <= now
}

function outcomeOf(
  command: BudgetCommand,
  params: Readonly<{
    budget: BudgetRecord | null
    ledger: Ledger
    row: Operation | null
    replayed: boolean
    changes: readonly ConfigChange[]
    /** This transition's periods, then the stored ones. */
    history: readonly WindowPeriod[]
    now: number
  }>
): BudgetOutcome {
  const { budget, ledger, row, replayed, now } = params
  if (command.type === "sweep") return { type: "sweep" }
  if (!budget) throw new Error(`${command.type} accepted without a budget`)
  const balance = balanceOf({ budget, ledger }, now)

  switch (command.type) {
    case "upsert":
      return {
        type: "upsert",
        changes: params.changes,
        budget: snapshotOf(budget, ledger, balance, now),
      }
    case "get":
      return {
        type: "get",
        budget: snapshotOf(budget, ledger, balance, now),
        history: historyOf(budget, params.history),
      }
    case "authorize": {
      if (row?.kind !== "hold") throw new Error("authorize produced no hold row")
      const { id: holdId, amount, expiresAt } = row
      return { type: "authorize", holdId, amount, expiresAt, replayed, balance }
    }
    case "charge":
    case "record": {
      if (row?.kind !== command.type)
        throw new Error(`${command.type} produced no ${command.type} row`)
      return { type: command.type, amount: row.amount, crossed: row.crossed, replayed, balance }
    }
    case "release": {
      if (row?.kind !== "hold" || row.state.status !== "released") {
        throw new Error(`release of ${command.holdId} produced no released row`)
      }
      return { type: "release", holdId: row.id, released: row.amount, replayed, balance }
    }
    case "settle": {
      if (row?.kind !== "hold" || row.state.status !== "settled") {
        throw new Error(`settle of ${command.holdId} produced no settled row`)
      }
      const { actual, closedAt, crossed } = row.state
      return {
        type: "settle",
        holdId: row.id,
        actual,
        released: row.amount - actual,
        expired: closedAt >= row.expiresAt,
        crossed,
        replayed,
        balance,
      }
    }
    case "lease": {
      if (row?.kind !== "lease") throw new Error("lease produced no lease row")
      if (row.state.status === "refused") {
        return { type: "refused", blocked: row.state.blocked, replayed, balance }
      }
      return { type: "lease", lease: leaseView(row), terms: termsOf(budget), replayed, balance }
    }
    case "report": {
      if (row?.kind !== "lease" || !row.last) {
        throw new Error(`report on ${command.leaseKey} produced no reported lease`)
      }
      const { request, extended, denied, crossed } = row.last
      return {
        type: "report",
        lease: leaseView(row),
        terms: termsOf(budget),
        extension: { requested: request.final ? ZERO : request.extend, granted: extended, denied },
        released: request.final ? row.granted - row.captured : ZERO,
        crossed,
        replayed,
        balance,
      }
    }
  }
}

function leaseView(lease: LeaseOperation): LeaseView {
  const { leaseKey, granted, captured, expiresAt, last, state } = lease
  if (state.status === "refused") throw new Error(`lease ${leaseKey} was refused`)
  return { leaseKey, seq: last?.seq ?? 0, granted, captured, expiresAt, status: state.status }
}

function termsOf(budget: BudgetRecord) {
  return { holds: budget.config.holds, closesAt: budget.config.closesAt }
}

function snapshotOf(budget: BudgetRecord, ledger: Ledger, balance: BudgetBalance, now: number) {
  const { key, unit, version, config } = budget
  const closed = isClosed(config, now)
  return { key, unit, version, ...config, closed, balance, operations: ledger.operations }
}

/** Up to WINDOW_HISTORY_PERIODS periods per limited window, newest first. */
function historyOf(budget: BudgetRecord, periods: readonly WindowPeriod[]): WindowPeriod[] {
  return limitedWindows(budget).flatMap((id) =>
    periods.filter((period) => period.windowId === id).slice(0, WINDOW_HISTORY_PERIODS)
  )
}
