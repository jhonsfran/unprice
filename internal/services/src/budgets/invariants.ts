/** Conservation (ADR-0006 B7.5): what every transition must preserve before it may commit. */

import type { Amount } from "@unprice/money"
import { countersOf, evolveOperation, ledgerDelta, operationIdOf } from "./evolve"
import type { BudgetState, Entry, Ledger, Operation } from "./model"

const ZERO = BigInt(0)

/** Counted against limits: `amount` while open, else 0. */
function heldBy(operation: Operation | undefined): Amount {
  return operation?.kind === "hold" && operation.state.status === "open" ? operation.amount : ZERO
}

function consumedBy(operation: Operation | undefined): Amount {
  if (!operation) return ZERO
  if (operation.kind !== "hold") return operation.amount
  return operation.state.status === "settled" ? operation.state.actual : ZERO
}

/**
 * Violations of the transition invariants; empty when it may commit. O(entries + touched rows).
 * 1. Seqs are contiguous from `before.ledger.seq + 1`; `at` never goes below `lastAt` or back.
 * 2. Two independent folds agree: the ledger's held and lifetime consumed moved by exactly the
 *    sum of `ledgerDelta`, and by exactly the change in `heldBy` and consumption over the rows.
 * 3. Per fact: settle has actual = covered + overrun and, unless late, covered + released = the
 *    hold's amount; a lapse or a release from an open hold returns its whole amount.
 * 4. Held, every window's consumed, and every fact amount are non-negative.
 * 5. Per counter, nothing is lost or counted twice across a roll: consumed after plus what
 *    `window.rolled` reported equals consumed before plus what this transition consumed. A roll
 *    reports the counter's period and only a period with usage, once per counter.
 */
export function checkTransition(
  before: BudgetState,
  entries: readonly Entry[],
  after: BudgetState
): string[] {
  const violations: string[] = []
  let heldDelta = ZERO
  let consumedDelta = ZERO
  let lastAt = before.ledger.lastAt
  const rows = new Map(before.operations)

  entries.forEach((entry, index) => {
    const expectedSeq = before.ledger.seq + index + 1
    if (entry.seq !== expectedSeq) violations.push(`entry seq ${entry.seq} expected ${expectedSeq}`)
    if (entry.at < lastAt) violations.push(`entry ${entry.seq} at ${entry.at} before ${lastAt}`)
    lastAt = Math.max(lastAt, entry.at)

    const delta = ledgerDelta(entry)
    heldDelta += delta.held
    consumedDelta += delta.consumed
    violations.push(...factViolations(entry, rows))

    const id = operationIdOf(entry)
    if (id !== null) {
      const row = evolveOperation(rows.get(id), entry)
      if (row) rows.set(id, row)
    }
  })

  if (after.ledger.seq !== before.ledger.seq + entries.length) {
    violations.push(
      `ledger seq ${after.ledger.seq} after ${entries.length} entries from ${before.ledger.seq}`
    )
  }
  if (after.ledger.held - before.ledger.held !== heldDelta) {
    violations.push(
      `ledger held moved ${after.ledger.held - before.ledger.held}, facts say ${heldDelta}`
    )
  }
  const lifetime = after.ledger.usage.never.consumed - before.ledger.usage.never.consumed
  if (lifetime !== consumedDelta) {
    violations.push(`ledger consumed moved ${lifetime}, facts say ${consumedDelta}`)
  }

  let rowsHeld = ZERO
  let rowsConsumed = ZERO
  for (const id of new Set([...before.operations.keys(), ...after.operations.keys()])) {
    rowsHeld += heldBy(after.operations.get(id)) - heldBy(before.operations.get(id))
    rowsConsumed += consumedBy(after.operations.get(id)) - consumedBy(before.operations.get(id))
  }
  if (rowsHeld !== heldDelta) violations.push(`rows held moved ${rowsHeld}, facts say ${heldDelta}`)
  if (rowsConsumed !== consumedDelta) {
    violations.push(`rows consumed moved ${rowsConsumed}, facts say ${consumedDelta}`)
  }

  if (after.ledger.held < ZERO) violations.push(`ledger held ${after.ledger.held} is negative`)
  for (const [id, counter] of countersOf(after.ledger.usage)) {
    if (counter.consumed < ZERO) violations.push(`${id} consumed ${counter.consumed} is negative`)
  }
  violations.push(...rollViolations(before.ledger, entries, after.ledger, consumedDelta))
  return violations
}

function rollViolations(
  before: Ledger,
  entries: readonly Entry[],
  after: Ledger,
  consumedDelta: Amount
): string[] {
  const violations: string[] = []
  const rolled = new Map<string, Amount>()
  for (const entry of entries) {
    if (entry.type !== "window.rolled") continue
    const counter = before.usage[entry.windowId]
    if (rolled.has(entry.windowId)) violations.push(`${entry.windowId} rolled twice`)
    if (entry.consumed <= ZERO) violations.push(`${entry.windowId} rolled an empty period`)
    if (counter?.start !== entry.start || entry.end <= entry.start) {
      violations.push(`${entry.windowId} rolled [${entry.start}, ${entry.end}), not its period`)
    }
    rolled.set(entry.windowId, entry.consumed)
  }
  const ids = new Set([...Object.keys(before.usage), ...Object.keys(after.usage)])
  for (const id of ids as Set<keyof Ledger["usage"]>) {
    const now = after.usage[id]
    const kept = (now?.consumed ?? ZERO) + (rolled.get(id) ?? ZERO)
    const owed = (before.usage[id]?.consumed ?? ZERO) + (now ? consumedDelta : ZERO)
    if (kept !== owed) violations.push(`${id} kept ${kept} of ${owed} consumed`)
  }
  return violations
}

function factViolations(entry: Entry, rows: ReadonlyMap<string, Operation>): string[] {
  const violations: string[] = []
  const negative = (name: string, value: Amount) => {
    if (value < ZERO) violations.push(`entry ${entry.seq} ${name} ${value} is negative`)
  }
  switch (entry.type) {
    case "hold.placed":
    case "charged":
    case "recorded":
      negative("amount", entry.amount)
      break
    case "hold.lapsed":
    case "hold.released": {
      negative("released", entry.released)
      const hold = rows.get(entry.holdId)
      const status = hold?.kind === "hold" ? hold.state.status : "missing"
      const expected = hold?.kind === "hold" && status === "open" ? hold.amount : ZERO
      if (entry.type === "hold.lapsed" && status !== "open") {
        violations.push(`entry ${entry.seq} lapses a ${status} hold`)
      }
      if (entry.released !== expected) {
        violations.push(
          `entry ${entry.seq} released ${entry.released} from a ${status} hold of ${expected}`
        )
      }
      break
    }
    case "hold.settled": {
      negative("covered", entry.covered)
      negative("released", entry.released)
      negative("overrun", entry.overrun)
      if (entry.actual !== entry.covered + entry.overrun) {
        violations.push(`entry ${entry.seq} actual ${entry.actual} != covered + overrun`)
      }
      const hold = rows.get(entry.holdId)
      const open = hold?.kind === "hold" && hold.state.status === "open"
      if (entry.late === open) {
        violations.push(`entry ${entry.seq} late=${entry.late} on an open=${open} hold`)
      }
      const amount = open && hold?.kind === "hold" ? hold.amount : ZERO
      if (entry.covered + entry.released !== amount) {
        violations.push(`entry ${entry.seq} covered + released != ${amount}`)
      }
      break
    }
    case "budget.configured":
      break
  }
  return violations
}
