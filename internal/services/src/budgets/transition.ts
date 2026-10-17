/**
 * Pure budget core (ADR-0006 B1-B3, B7). No clock, no I/O.
 *
 * `decide` owns every policy rule and returns the change a command makes, or a rejection.
 * `transition` sweeps first (lapses due holds, rolls ended windows), decides, applies the change to
 * the ledger, and checks conservation. A store keeps what it returns in one transaction: the
 * ledger (one row, the authoritative balance), one row per operation (open hold, closed
 * tombstone, idempotency record), and the window history.
 */

import { Err, Ok, type Result } from "@unprice/error"
import { type BudgetRecord, type ConfigChange, WINDOW_HISTORY_PERIODS, isClosed } from "./config"
import { balanceOf, decide, holdNumber, lapse } from "./decide"
import { type RowStep, checkTransition } from "./invariants"
import { consume, dueAt, rollUsage, trackLimits } from "./ledger"
import type {
  BudgetBalance,
  BudgetCommand,
  BudgetOutcome,
  BudgetView,
  HoldOperation,
  Ledger,
  Operation,
  UnPriceBudgetError,
  WindowPeriod,
} from "./model"
import { type WindowId, windowIdOf } from "./windows"

/** The reads a store answers inside its transaction. Rows come back as domain types. */
export type BudgetReader = {
  readBudget(): BudgetRecord | null
  readLedger(): Ledger
  readOperation(id: string): Operation | null
  readOperationByKey(idempotencyKey: string): Operation | null
  /** Open holds with `lapsesAt <= at`, earliest first, at most `limit`. */
  readDueHolds(at: number, limit: number): HoldOperation[]
  /** Up to `limit` stored periods of each window id, newest first. */
  readHistory(windowIds: readonly WindowId[], limit: number): WindowPeriod[]
}

/**
 * What `transition` reads for one command: the row it addresses, up to `dueLimit` due holds, and
 * the history a `get` returns.
 */
export function loadView(
  reader: BudgetReader,
  command: BudgetCommand,
  clockMs: number,
  dueLimit: number
): BudgetView {
  const ledger = reader.readLedger()
  const budget = reader.readBudget()
  return {
    budget,
    ledger,
    target: targetOf(reader, command),
    due: reader.readDueHolds(Math.max(clockMs, ledger.lastAt), dueLimit),
    history:
      command.type === "get" && budget
        ? reader.readHistory(limitedWindows(budget), WINDOW_HISTORY_PERIODS)
        : [],
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
  outcome: BudgetOutcome
  /**
   * Earliest `dueAt` among the written rows; the store only ever lowers its alarm to it. A window
   * boundary needs no wake: a counter keeps its period's start, so the next command rolls it the
   * same however late it comes.
   */
  wakeAt: number | null
}>

/**
 * The one call a store makes per command: clamp the clock, lapse the due holds it loaded and roll
 * ended windows, decide, apply, check, outcome. A rejection returns Err and the store writes
 * nothing, not even the lapses or rolls. Throws when an invariant breaks (a programmer error that
 * must abort the transaction).
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
  const expired = view.target && isExpired(view.target, now) ? view.target : null
  const live = expired ? null : view.target
  const read = new Map<string, Operation>(view.due.map((hold) => [hold.id, hold]))
  if (live) read.set(live.id, live)
  const limits = view.budget?.config.limits ?? []
  const rolled = rollUsage(view.ledger.usage, now, limits)
  const lapsed = lapse(read.values(), now)
  const swept = new Map<string, Operation>(lapsed.rows.map((row) => [row.id, row]))
  const rows = new Map(swept)
  const sweptLedger: Ledger = {
    ...view.ledger,
    held: view.ledger.held + lapsed.held,
    usage: rolled.usage,
  }
  const target = live ? (swept.get(live.id) ?? live) : null

  const decided = decide(command, { budget: view.budget, ledger: sweptLedger, target }, now)
  if (decided.err) return Err(decided.err)
  const change = decided.val
  for (const row of change.rows) rows.set(row.id, row)

  const budget = change.configured?.budget ?? view.budget
  const usage = change.configured
    ? trackLimits(sweptLedger.usage, change.configured.budget.config.limits, now)
    : sweptLedger.usage
  const ledger: Ledger = {
    lastAt: now,
    holdSeq: change.rows.reduce(
      (seq, row) => (row.kind === "hold" ? Math.max(seq, holdNumber(row.id)) : seq),
      sweptLedger.holdSeq
    ),
    held: sweptLedger.held + change.held,
    usage: consume(usage, change.consumed),
  }
  const operations = [...rows.values()]
  const { periods } = rolled

  const violations = checkTransition({
    before: view.ledger,
    after: ledger,
    limits,
    steps: [
      ...lapsed.rows.map((row): RowStep => [read.get(row.id), row]),
      ...change.rows.map((row): RowStep => [swept.get(row.id) ?? read.get(row.id), row]),
    ],
    periods,
  })
  if (violations.length > 0) {
    throw new Error(`budget transition breaks invariants: ${violations.join("; ")}`)
  }

  let wakeAt: number | null = null
  for (const operation of operations) {
    const due = dueAt(operation)
    if (wakeAt === null || due < wakeAt) wakeAt = due
  }
  // A sweep always moves the budget's clock to now, so the purge after it never runs ahead of a
  // later command's clamped clock.
  const write =
    budget !== null &&
    (operations.length > 0 ||
      periods.length > 0 ||
      change.configured !== undefined ||
      command.type === "sweep")

  return Ok({
    now,
    write,
    budget: change.configured?.budget ?? null,
    ledger,
    purged: expired && change.rows.length > 0 ? [expired] : [],
    operations,
    periods,
    outcome: outcomeOf(command, {
      budget,
      ledger,
      row: change.row,
      replayed: change.rows.length === 0,
      changes: change.configured?.changes ?? [],
      history: [...periods, ...view.history],
      lapsed: lapsed.rows.length,
      now,
    }),
    wakeAt,
  })
}

function isExpired(row: Operation, now: number): boolean {
  const open = row.kind === "hold" && row.state.status === "open"
  return !open && dueAt(row) <= now
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
    lapsed: number
    now: number
  }>
): BudgetOutcome {
  const { budget, ledger, row, replayed, now } = params
  if (command.type === "sweep") return { type: "sweep", lapsed: params.lapsed }
  if (!budget) throw new Error(`${command.type} accepted without a budget`)
  const balance = balanceOf({ budget, ledger }, now)

  switch (command.type) {
    case "upsert":
      return { type: "upsert", changes: params.changes, budget: snapshotOf(budget, balance, now) }
    case "get":
      return {
        type: "get",
        budget: snapshotOf(budget, balance, now),
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
      const { released } = row.state
      return { type: "release", holdId: row.id, released, replayed, balance }
    }
    case "settle": {
      if (row?.kind !== "hold" || row.state.status !== "settled") {
        throw new Error(`settle of ${command.holdId} produced no settled row`)
      }
      const { closedAt, status: _, ...settled } = row.state
      const expired = settled.late || closedAt >= row.expiresAt
      return { type: "settle", holdId: row.id, ...settled, expired, replayed, balance }
    }
  }
}

function snapshotOf(budget: BudgetRecord, balance: BudgetBalance, now: number) {
  const { key, unit, version, config } = budget
  return { key, unit, version, ...config, closed: isClosed(config, now), balance }
}

/** Up to WINDOW_HISTORY_PERIODS periods per limited window, newest first. */
function historyOf(budget: BudgetRecord, periods: readonly WindowPeriod[]): WindowPeriod[] {
  return limitedWindows(budget).flatMap((id) =>
    periods.filter((period) => period.windowId === id).slice(0, WINDOW_HISTORY_PERIODS)
  )
}
