/**
 * Pure budget core (ADR-0006 B1-B3, B7). No clock, no I/O, no crypto.
 *
 * `decide` owns every policy rule and returns facts or a rejection; `evolve` folds a fact into the
 * projections with arithmetic only. A store keeps three projections in one transaction: the
 * ledger (one row, the authoritative balance), one row per operation (open hold, closed
 * tombstone, idempotency record), and the journal entries, an audit trail it prunes after a day.
 * Every fact carries its own deltas, so the ledger and the operation rows are two independent
 * folds that `checkTransition` compares on every command.
 */

import { Err, Ok, type Result } from "@unprice/error"
import type { BudgetRecord } from "./config"
import { balanceOf, decide, lapseFacts } from "./decide"
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
  UnPriceBudgetError,
} from "./model"

/** The reads a store answers inside its transaction. Rows come back as domain types. */
export type BudgetReader = {
  readBudget(): BudgetRecord | null
  readLedger(): Ledger
  readOperation(id: string): Operation | null
  readOperationByKey(idempotencyKey: string): Operation | null
  /** Open holds with `lapsesAt <= at`, earliest first, at most `limit`. */
  readDueHolds(at: number, limit: number): HoldOperation[]
}

/** What `transition` reads for one command: the row it addresses and up to `dueLimit` due holds. */
export function loadView(
  reader: BudgetReader,
  command: BudgetCommand,
  clockMs: number,
  dueLimit: number
): BudgetView {
  const ledger = reader.readLedger()
  return {
    budget: reader.readBudget(),
    ledger,
    target: targetOf(reader, command),
    due: reader.readDueHolds(Math.max(clockMs, ledger.lastAt), dueLimit),
  }
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
  /** Earliest `dueAt` among the written rows; the store only ever lowers its alarm to it. */
  wakeAt: number | null
}>

/**
 * The one call a store makes per command:
 * clamp the clock, lapse the due holds it loaded, decide, stamp seqs, fold, check, outcome.
 * A rejection returns Err and the store writes nothing, not even the lapses.
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
  const lapseEntries = stamp(lapseFacts(before.operations.values(), now), view.ledger.seq, now)
  const swept = lapseEntries.reduce(evolve, before)
  const target = view.target ? (swept.operations.get(view.target.id) ?? null) : null

  const decided = decide(command, { budget: swept.budget, ledger: swept.ledger, target }, now)
  if (decided.err) return Err(decided.err)

  const commandEntries = stamp(decided.val, swept.ledger.seq, now)
  const next = commandEntries.reduce(evolve, swept)
  const entries = [...lapseEntries, ...commandEntries]

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
    outcome: outcomeOf(command, next, commandEntries, target, lapseEntries.length, now),
    wakeAt,
  })
}

function stamp(facts: readonly Fact[], seq: number, at: number): Entry[] {
  return facts.map((fact, index) => ({ ...fact, seq: seq + index + 1, at }))
}

function outcomeOf(
  command: BudgetCommand,
  next: BudgetState,
  entries: readonly Entry[],
  target: Operation | null,
  lapsed: number,
  now: number
): BudgetOutcome {
  if (command.type === "sweep") return { type: "sweep", lapsed }
  const budget = next.budget
  if (!budget) throw new Error(`${command.type} accepted without a budget`)
  const balance = balanceOf({ budget, ledger: next.ledger }, now)
  const replayed = entries.length === 0
  const written = entries[0] ? operationIdOf(entries[0]) : null
  const row = (written === null ? target : next.operations.get(written)) ?? null

  switch (command.type) {
    case "upsert": {
      const fact = entries[0]
      const changes = fact?.type === "budget.configured" ? fact.changes : []
      return { type: "upsert", changes, budget: snapshotOf(budget, balance) }
    }
    case "get":
      return { type: "get", budget: snapshotOf(budget, balance) }
    case "authorize": {
      if (row?.kind !== "hold") throw new Error("authorize produced no hold row")
      const { id: holdId, amount, expiresAt } = row
      return { type: "authorize", holdId, amount, expiresAt, replayed, balance }
    }
    case "charge":
    case "record": {
      if (row?.kind !== command.type) throw new Error(`${command.type} produced no row`)
      return { type: command.type, amount: row.amount, crossed: row.crossed, replayed, balance }
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

function snapshotOf(budget: BudgetRecord, balance: BudgetBalance) {
  const { key, unit, version, config } = budget
  return { key, unit, version, ...config, balance }
}
