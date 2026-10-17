/** Conservation (ADR-0006 B7.5): what every transition must preserve before it may commit. */

import type { Amount } from "@unprice/money"
import type { BudgetLimit } from "./config"
import { countersOf } from "./ledger"
import type { Ledger, Operation, WindowPeriod } from "./model"
import { windowIdOf } from "./windows"

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

/** One row moving from what it was (undefined when created) to what it became. */
export type RowStep = readonly [prior: Operation | undefined, row: Operation]

export type CheckedTransition = Readonly<{
  before: Ledger
  after: Ledger
  /** The limits in force before the transition, which decide what a roll reports. */
  limits: readonly BudgetLimit[]
  /** Every row step in order: a hold that lapses and then settles takes two. */
  steps: readonly RowStep[]
  periods: readonly WindowPeriod[]
}>

/**
 * Violations of the transition invariants; empty when it may commit. O(touched rows + counters).
 * 1. Every row step is legal in its lifecycle, with the hold's arithmetic intact.
 * 2. The ledger's held moved by exactly the change in `heldBy` over the touched rows.
 * 3. Per counter, nothing is lost or counted twice: a counter that kept its period grew by exactly
 *    what the rows consumed; one that moved to a new period holds only that, and its old period
 *    is reported when it had usage on a limited window.
 * 4. Held and every counter are non-negative.
 */
export function checkTransition(transition: CheckedTransition): string[] {
  const { before, after, steps } = transition
  const violations: string[] = []
  let held = ZERO
  let consumed = ZERO
  for (const [prior, row] of steps) {
    violations.push(...stepViolations(prior, row))
    held += heldBy(row) - heldBy(prior)
    consumed += consumedBy(row) - consumedBy(prior)
  }
  if (after.held - before.held !== held) {
    violations.push(`ledger held moved ${after.held - before.held}, rows say ${held}`)
  }
  if (after.held < ZERO) violations.push(`ledger held ${after.held} is negative`)
  violations.push(...counterViolations(transition, consumed))
  return violations
}

/** The hold lifecycle: open -> lapsed | settled | released, lapsed -> settled | released. */
function stepViolations(prior: Operation | undefined, row: Operation): string[] {
  const at = `row ${row.id}`
  if (row.amount < ZERO) return [`${at} amount ${row.amount} is negative`]
  if (row.kind !== "hold") return prior ? [`${at} ${row.kind} was written twice`] : []
  if (!prior) return row.state.status === "open" ? [] : [`${at} was created ${row.state.status}`]
  if (prior.kind !== "hold" || prior.amount !== row.amount) return [`${at} changed identity`]

  const from = prior.state.status
  const state = row.state
  switch (state.status) {
    case "lapsed":
      return from === "open" ? [] : [`${at} lapsed from ${from}`]
    case "released": {
      const expected = from === "open" ? row.amount : ZERO
      if (from !== "open" && from !== "lapsed") return [`${at} released from ${from}`]
      return state.released === expected ? [] : [`${at} released ${state.released} of ${expected}`]
    }
    case "settled": {
      if (from !== "open" && from !== "lapsed") return [`${at} settled from ${from}`]
      const violations: string[] = []
      const { actual, covered, released, overrun, late } = state
      if (covered < ZERO || released < ZERO || overrun < ZERO) {
        violations.push(`${at} settled with a negative part`)
      }
      if (actual !== covered + overrun)
        violations.push(`${at} actual ${actual} != covered + overrun`)
      if (late !== (from === "lapsed"))
        violations.push(`${at} late=${late} settling a ${from} hold`)
      const returnable = from === "open" ? row.amount : ZERO
      if (covered + released !== returnable) {
        violations.push(`${at} covered + released != ${returnable}`)
      }
      return violations
    }
    case "open":
      return [`${at} reopened from ${from}`]
  }
}

function counterViolations(
  { before, after, limits, periods }: CheckedTransition,
  consumed: Amount
): string[] {
  const violations: string[] = []
  const limited = new Set(limits.map(windowIdOf))
  const reported = new Map<string, WindowPeriod>()
  for (const period of periods) {
    if (reported.has(period.windowId)) violations.push(`${period.windowId} rolled twice`)
    if (period.consumed <= ZERO) violations.push(`${period.windowId} rolled an empty period`)
    if (period.end <= period.start || !after.usage[period.windowId]) {
      violations.push(`${period.windowId} rolled [${period.start}, ${period.end}), not a period`)
    }
    reported.set(period.windowId, period)
  }

  for (const [id, counter] of countersOf(after.usage)) {
    if (counter.consumed < ZERO) violations.push(`${id} consumed ${counter.consumed} is negative`)
    const prior = before.usage[id]
    const period = reported.get(id)
    if (prior && counter.start === prior.start) {
      if (counter.consumed !== prior.consumed + consumed) {
        violations.push(`${id} counted ${counter.consumed}, expected ${prior.consumed + consumed}`)
      }
      if (period) violations.push(`${id} reported a roll but kept its period`)
      continue
    }
    if (counter.consumed !== consumed) {
      violations.push(`${id} started a period with ${counter.consumed}, expected ${consumed}`)
    }
    if (!prior) continue
    if (counter.start < prior.start) violations.push(`${id} rolled backwards`)
    const owed = prior.consumed > ZERO && limited.has(id)
    if (owed !== (period !== undefined)) violations.push(`${id} rolled without its period`)
    if (period && (period.start !== prior.start || period.consumed !== prior.consumed)) {
      violations.push(`${id} reported [${period.start}, ${period.end}), not its period`)
    }
  }
  return violations
}
