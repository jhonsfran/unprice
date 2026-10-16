/** Folds (ADR-0006 B7): arithmetic only, no policy. Every fact carries its own deltas. */

import type { Amount, SignedAmount } from "@unprice/money"
import { OPERATION_RETENTION_MS } from "./config"
import type {
  BudgetState,
  Entry,
  Fact,
  HoldOperation,
  HoldState,
  Ledger,
  Operation,
  WindowUsage,
} from "./model"
import { BUDGET_WINDOWS, type BudgetWindow, budgetWindowBounds } from "./windows"

const ZERO = BigInt(0)

/**
 * The single table of ledger effects.
 *
 * | fact               | held                  | consumed |
 * | hold.placed        | +amount               | 0        |
 * | hold.lapsed        | -released             | 0        |
 * | hold.settled       | -(covered + released) | +actual  |
 * | hold.released      | -released             | 0        |
 * | charged, recorded  | 0                     | +amount  |
 * | budget.configured  | 0                     | 0        |
 */
export function ledgerDelta(fact: Fact): { held: SignedAmount; consumed: Amount } {
  switch (fact.type) {
    case "hold.placed":
      return { held: fact.amount, consumed: ZERO }
    case "hold.lapsed":
    case "hold.released":
      return { held: -fact.released, consumed: ZERO }
    case "hold.settled":
      return { held: -(fact.covered + fact.released), consumed: fact.actual }
    case "charged":
    case "recorded":
      return { held: ZERO, consumed: fact.amount }
    case "budget.configured":
      return { held: ZERO, consumed: ZERO }
  }
}

/** Folds one entry into the ledger. Rolls each window forward only, then applies `ledgerDelta`. */
export function evolveLedger(ledger: Ledger, entry: Entry): Ledger {
  const delta = ledgerDelta(entry)
  const usage = {} as Record<BudgetWindow, WindowUsage>
  for (const window of BUDGET_WINDOWS) {
    const current = ledger.usage[window]
    const start = budgetWindowBounds(window, entry.at).start
    const base = start > current.start ? { start, consumed: ZERO } : current
    usage[window] =
      delta.consumed === ZERO
        ? base
        : { start: base.start, consumed: base.consumed + delta.consumed }
  }
  return {
    seq: entry.seq,
    lastAt: Math.max(ledger.lastAt, entry.at),
    holdSeq: ledger.holdSeq + (entry.type === "hold.placed" ? 1 : 0),
    held: ledger.held + delta.held,
    usage,
  }
}

/** The operation row an entry touches, or null for `budget.configured`. */
export function operationIdOf(entry: Entry): string | null {
  switch (entry.type) {
    case "budget.configured":
      return null
    case "charged":
    case "recorded":
      return `o_${entry.seq}`
    default:
      return entry.holdId
  }
}

/** Folds one entry into the operation row it names. */
export function evolveOperation(
  operation: Operation | undefined,
  entry: Entry
): Operation | undefined {
  switch (entry.type) {
    case "budget.configured":
      return operation
    case "hold.placed":
      return {
        kind: "hold",
        id: entry.holdId,
        idempotencyKey: entry.idempotencyKey,
        requestHash: entry.requestHash,
        amount: entry.amount,
        createdAt: entry.at,
        expiresAt: entry.expiresAt,
        lapsesAt: entry.lapsesAt,
        state: { status: "open" },
      }
    case "charged":
    case "recorded":
      return {
        kind: entry.type === "charged" ? "charge" : "record",
        id: `o_${entry.seq}`,
        idempotencyKey: entry.idempotencyKey,
        requestHash: entry.requestHash,
        amount: entry.amount,
        createdAt: entry.at,
        crossed: entry.crossed,
      }
    case "hold.settled":
      return withHoldState(operation, entry, {
        status: "settled",
        closedAt: entry.at,
        actual: entry.actual,
        covered: entry.covered,
        released: entry.released,
        overrun: entry.overrun,
        late: entry.late,
        crossed: entry.crossed,
      })
    case "hold.lapsed":
      return withHoldState(operation, entry, { status: "lapsed", lapsedAt: entry.at })
    case "hold.released":
      return withHoldState(operation, entry, {
        status: "released",
        closedAt: entry.at,
        released: entry.released,
      })
  }
}

function withHoldState(
  operation: Operation | undefined,
  entry: Entry,
  state: HoldState
): HoldOperation {
  if (operation?.kind !== "hold") {
    throw new Error(`entry ${entry.seq} (${entry.type}) has no hold row`)
  }
  return { ...operation, state }
}

/** Folds one entry into every projection. Changed rows are new objects; unchanged keep identity. */
export function evolve(state: BudgetState, entry: Entry): BudgetState {
  const id = operationIdOf(entry)
  let operations = state.operations
  if (id !== null) {
    const next = evolveOperation(state.operations.get(id), entry)
    const copy = new Map(state.operations)
    if (next) copy.set(id, next)
    operations = copy
  }
  return {
    budget: entry.type === "budget.configured" ? entry.budget : state.budget,
    ledger: evolveLedger(state.ledger, entry),
    operations,
  }
}

/**
 * When a row next needs attention: an open hold lapses at `lapsesAt`; every other row is purged
 * OPERATION_RETENTION_MS after it closed. A store mirrors this in an indexed `due_at` column.
 */
export function dueAt(operation: Operation): number {
  if (operation.kind !== "hold") return operation.createdAt + OPERATION_RETENTION_MS
  switch (operation.state.status) {
    case "open":
      return operation.lapsesAt
    case "lapsed":
      return operation.state.lapsedAt + OPERATION_RETENTION_MS
    case "settled":
    case "released":
      return operation.state.closedAt + OPERATION_RETENTION_MS
  }
}
