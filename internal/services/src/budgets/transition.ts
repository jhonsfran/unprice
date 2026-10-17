/**
 * Pure budget core (ADR-0006 B1-B3, B7). No clock, no I/O, no crypto.
 *
 * `decide` owns every policy rule and returns facts or a rejection; `evolve` folds a fact into the
 * projections with arithmetic only. A store keeps three projections in one transaction: the
 * ledger (one row, the authoritative balance), one row per operation (open hold, closed
 * tombstone, idempotency record), and the journal entries, an audit trail it prunes after a day.
 * From the same entries it derives the window history (`window.rolled`) and the record receipts
 * (`recorded`). Every fact carries its own deltas, so the ledger and the operation rows are two
 * independent folds that `checkTransition` compares on every command.
 */

import { Err, Ok, type Result } from "@unprice/error"
import { type BudgetRecord, WINDOW_HISTORY_PERIODS, isClosed } from "./config"
import { balanceOf, decide, lapseFacts, rollFacts } from "./decide"
import { dueAt, evolve, operationIdOf } from "./evolve"
import { checkTransition } from "./invariants"
import type {
  BudgetBalance,
  BudgetCommand,
  BudgetOutcome,
  BudgetState,
  BudgetView,
  Entry,
  Fact,
  HoldOperation,
  Ledger,
  Operation,
  RecordReceipt,
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
  /** The receipt `recorded` wrote for this key, if its RECORD_DEDUPE_MS had not passed by `at`. */
  readRecordReceipt(idempotencyKey: string, at: number): RecordReceipt | null
  /** Up to `limit` stored periods of each window id, newest first. */
  readHistory(windowIds: readonly WindowId[], limit: number): WindowPeriod[]
}

/**
 * What `transition` reads for one command: the row it addresses, up to `dueLimit` due holds, a
 * record's receipt when its row is gone, and the history a `get` returns.
 */
export function loadView(
  reader: BudgetReader,
  command: BudgetCommand,
  clockMs: number,
  dueLimit: number
): BudgetView {
  const ledger = reader.readLedger()
  const budget = reader.readBudget()
  const at = Math.max(clockMs, ledger.lastAt)
  const target = targetOf(reader, command)
  return {
    budget,
    ledger,
    target,
    due: reader.readDueHolds(at, dueLimit),
    receipt:
      command.type === "record" && !target
        ? reader.readRecordReceipt(command.idempotencyKey, at)
        : null,
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

/** The projections a view holds, before any fact is folded. */
export function viewState(view: BudgetView): BudgetState {
  const operations = new Map<string, Operation>(view.due.map((hold) => [hold.id, hold]))
  if (view.target) operations.set(view.target.id, view.target)
  return { budget: view.budget, ledger: view.ledger, operations }
}

export type BudgetTransition = Readonly<{
  /** The clamped clock every entry is stamped with. */
  now: number
  entries: readonly Entry[]
  next: BudgetState
  /** Rows created or changed; the store upserts exactly these. */
  operations: readonly Operation[]
  outcome: BudgetOutcome
  /**
   * Earliest `dueAt` among the written rows; the store only ever lowers its alarm to it. A window
   * boundary needs no wake: a counter keeps its period's start, so the next command rolls it the
   * same however late it comes.
   */
  wakeAt: number | null
}>

/**
 * The one call a store makes per command:
 * clamp the clock, roll ended windows and lapse the due holds it loaded, decide, stamp seqs, fold,
 * check, outcome. A rejection returns Err and the store writes nothing, not even the rolls or lapses.
 * A replay is zero command facts; its outcome is read from the row plus the current balance.
 * Throws when an invariant breaks (a programmer error that must abort the transaction).
 */
export function transition(params: {
  view: BudgetView
  command: BudgetCommand
  clockMs: number
}): Result<BudgetTransition, UnPriceBudgetError> {
  const { view, command, clockMs } = params
  if (!Number.isSafeInteger(clockMs)) throw new Error(`clock ${clockMs} is not an integer`)
  const now = Math.max(clockMs, view.ledger.lastAt)

  const before = viewState(view)
  const lapses = lapseFacts(before.operations.values(), now)
  const sweepEntries = stamp([...rollFacts(view.ledger, now), ...lapses], view.ledger.seq, now)
  const swept = sweepEntries.reduce(evolve, before)
  const target = view.target ? (swept.operations.get(view.target.id) ?? null) : null

  const decided = decide(
    command,
    { budget: swept.budget, ledger: swept.ledger, target, receipt: view.receipt },
    now
  )
  if (decided.err) return Err(decided.err)

  const commandEntries = stamp(decided.val, swept.ledger.seq, now)
  const next = commandEntries.reduce(evolve, swept)
  const entries = [...sweepEntries, ...commandEntries]

  const violations = checkTransition(before, entries, next)
  if (violations.length > 0) {
    throw new Error(`budget transition breaks invariants: ${violations.join("; ")}`)
  }

  const operations = [...next.operations.values()].filter(
    (operation) => before.operations.get(operation.id) !== operation
  )
  let wakeAt: number | null = null
  for (const operation of operations) {
    const due = dueAt(operation)
    if (wakeAt === null || due < wakeAt) wakeAt = due
  }

  return Ok({
    now,
    entries,
    next,
    operations,
    outcome: outcomeOf(command, { view, next, entries, commandEntries, target, now }),
    wakeAt,
  })
}

function stamp(facts: readonly Fact[], seq: number, at: number): Entry[] {
  return facts.map((fact, index) => ({ ...fact, seq: seq + index + 1, at }))
}

function outcomeOf(
  command: BudgetCommand,
  params: Readonly<{
    view: BudgetView
    next: BudgetState
    /** Every entry, rolls and lapses included. */
    entries: readonly Entry[]
    commandEntries: readonly Entry[]
    target: Operation | null
    now: number
  }>
): BudgetOutcome {
  const { view, next, entries, commandEntries, target, now } = params
  if (command.type === "sweep") {
    return { type: "sweep", lapsed: entries.filter((e) => e.type === "hold.lapsed").length }
  }
  const budget = next.budget
  if (!budget) throw new Error(`${command.type} accepted without a budget`)
  const balance = balanceOf({ budget, ledger: next.ledger }, now)
  const replayed = commandEntries.length === 0
  const written = commandEntries[0] ? operationIdOf(commandEntries[0]) : null
  const row = (written === null ? target : next.operations.get(written)) ?? null

  switch (command.type) {
    case "upsert": {
      const fact = commandEntries[0]
      const changes = fact?.type === "budget.configured" ? fact.changes : []
      return { type: "upsert", changes, budget: snapshotOf(budget, balance, now) }
    }
    case "get":
      return {
        type: "get",
        budget: snapshotOf(budget, balance, now),
        history: historyOf(budget, view.history, entries),
      }
    case "authorize": {
      if (row?.kind !== "hold") throw new Error("authorize produced no hold row")
      const { id: holdId, amount, expiresAt } = row
      return { type: "authorize", holdId, amount, expiresAt, replayed, balance }
    }
    case "charge":
    case "record": {
      if (row && row.kind !== command.type)
        throw new Error(`${command.type} found a ${row.kind} row`)
      // A record replayed after its row's purge answers from its receipt.
      const answer = row ?? view.receipt
      if (!answer) throw new Error(`${command.type} produced no row`)
      return {
        type: command.type,
        amount: answer.amount,
        crossed: answer.crossed,
        replayed,
        balance,
      }
    }
    case "release": {
      if (row?.kind !== "hold" || row.state.status !== "released") {
        throw new Error(`release of ${command.holdId} produced no released row`)
      }
      const { released } = row.state
      return { type: "release", holdId: command.holdId, released, replayed, balance }
    }
    case "settle": {
      if (row?.kind !== "hold" || row.state.status !== "settled") {
        throw new Error(`settle of ${command.holdId} produced no settled row`)
      }
      const { actual, covered, released, overrun, late, crossed, closedAt } = row.state
      const expired = late || closedAt >= row.expiresAt
      return {
        type: "settle",
        holdId: command.holdId,
        actual,
        covered,
        released,
        overrun,
        late,
        expired,
        crossed,
        replayed,
        balance,
      }
    }
  }
}

function snapshotOf(budget: BudgetRecord, balance: BudgetBalance, now: number) {
  const { key, unit, version, config } = budget
  return { key, unit, version, ...config, closed: isClosed(config, now), balance }
}

/**
 * Stored periods plus the ones this transition rolled, newest first, per limited window. A
 * transition rolls a window at most once, into a period newer than any stored one, so it goes first.
 */
function historyOf(
  budget: BudgetRecord,
  stored: readonly WindowPeriod[],
  entries: readonly Entry[]
): WindowPeriod[] {
  const periods = [...entries.flatMap(periodOf), ...stored]
  return limitedWindows(budget).flatMap((id) =>
    periods.filter((period) => period.windowId === id).slice(0, WINDOW_HISTORY_PERIODS)
  )
}

/** The period a `window.rolled` entry reports; nothing for any other entry. */
export function periodOf(entry: Entry): WindowPeriod[] {
  if (entry.type !== "window.rolled") return []
  const { windowId, start, end, consumed } = entry
  return [{ windowId, start, end, consumed }]
}
