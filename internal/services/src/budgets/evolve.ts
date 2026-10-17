/** Folds (ADR-0006 B7): arithmetic only, no policy. Every fact carries its own deltas. */

import type { Amount, SignedAmount } from "@unprice/money"
import { type BudgetLimit, OPERATION_RETENTION_MS } from "./config"
import type {
  BudgetState,
  Entry,
  Fact,
  HoldOperation,
  HoldState,
  Ledger,
  Operation,
  WindowCounters,
  WindowUsage,
} from "./model"
import { type WindowId, windowBounds, windowIdOf, windowSpecOf } from "./windows"

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
 * | window.rolled      | 0                     | 0        |
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
    case "window.rolled":
      return { held: ZERO, consumed: ZERO }
  }
}

export function countersOf(usage: WindowCounters): Array<[WindowId, WindowUsage]> {
  return Object.entries(usage) as Array<[WindowId, WindowUsage]>
}

/**
 * Moves every counter forward (only) to the period containing `at`, and drops an orphan whose
 * period ended. Unchanged counters keep identity.
 */
export function rollCounters(usage: WindowCounters, at: number): WindowCounters {
  const next: Record<string, WindowUsage> = {}
  for (const [id, counter] of countersOf(usage)) {
    const start = windowBounds(windowSpecOf(id), at).start
    if (start <= counter.start) next[id] = counter
    else if (!counter.orphan) next[id] = { start, consumed: ZERO }
  }
  return next as WindowCounters
}

/**
 * After a config change: one counter per anchored window id the limits reference, a new one
 * counting from `at`, and the rest marked orphan until their period ends.
 */
function trackLimits(
  usage: WindowCounters,
  limits: readonly BudgetLimit[],
  at: number
): WindowCounters {
  const referenced = new Set(
    limits.filter((limit) => limit.anchor !== undefined).map((limit) => windowIdOf(limit))
  )
  const next: Record<string, WindowUsage> = {}
  for (const [id, counter] of countersOf(usage)) {
    const orphan = id.includes("@") && !referenced.has(id)
    next[id] = orphan === Boolean(counter.orphan) ? counter : withOrphan(counter, orphan)
  }
  for (const id of referenced) {
    next[id] ??= { start: windowBounds(windowSpecOf(id), at).start, consumed: ZERO }
  }
  return next as WindowCounters
}

function withOrphan({ start, consumed }: WindowUsage, orphan: boolean): WindowUsage {
  return orphan ? { start, consumed, orphan } : { start, consumed }
}

/**
 * Folds one entry into the ledger: rolls every counter forward to `entry.at`, follows a config
 * change, then applies `ledgerDelta`, adding consumption to every counter.
 */
export function evolveLedger(ledger: Ledger, entry: Entry): Ledger {
  const delta = ledgerDelta(entry)
  let usage = rollCounters(ledger.usage, entry.at)
  if (entry.type === "budget.configured") {
    usage = trackLimits(usage, entry.budget.config.limits, entry.at)
  }
  if (delta.consumed !== ZERO) {
    const added: Record<string, WindowUsage> = {}
    for (const [id, counter] of countersOf(usage)) {
      added[id] = { ...counter, consumed: counter.consumed + delta.consumed }
    }
    usage = added as WindowCounters
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
    case "window.rolled":
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
    case "window.rolled":
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

/**
 * Record keys whose dedupe ended by this time may be purged. It never runs ahead of the ledger's
 * clock: a command clamps to `lastAt`, so a key purged at a later raw clock could otherwise let a
 * skewed-back command accept a replay that is still inside the accept window.
 */
export function recordKeysPurgeAt(clockMs: number, ledger: Ledger): number {
  return Math.min(clockMs, ledger.lastAt)
}
