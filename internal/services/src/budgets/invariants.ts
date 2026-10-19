/** Conservation (ADR-0006 B7.5): what every transition must preserve before it may commit. */

import type { Amount } from "@unprice/money"
import type { BudgetLimit } from "./config"
import { countersOf, exposureOf } from "./ledger"
import type { LeaseOperation, Ledger, Operation, WindowPeriod } from "./model"
import { windowIdOf } from "./windows"

const ZERO = BigInt(0)

/** Counted against limits: an open reservation's exposure, else 0. */
function heldBy(operation: Operation | undefined): Amount {
  return operation?.kind === "hold" || operation?.kind === "lease" ? exposureOf(operation) : ZERO
}

function consumedBy(operation: Operation | undefined): Amount {
  if (!operation) return ZERO
  if (operation.kind === "lease") return operation.captured
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
  /** The limits in force after it, whose hard caps the transition must not push further past. */
  resultingLimits: readonly BudgetLimit[]
  /** Every operation row changed by the command. */
  steps: readonly RowStep[]
  periods: readonly WindowPeriod[]
}>

/**
 * Violations of the transition invariants; empty when it may commit. O(touched rows + counters).
 * 1. Every row step is legal in its lifecycle, with the hold's and the lease's arithmetic intact.
 * 2. The ledger's held moved by exactly the change in `heldBy` over the touched rows.
 * 3. Per counter, nothing is lost or counted twice: a counter that kept its period grew by exactly
 *    what the rows consumed; one that moved to a new period holds only that, and its old period
 *    is reported when it had usage on a limited window.
 * 4. Held and every counter are non-negative.
 * 5. No hard limit's consumed + held grows past its amount, except by recorded usage: that work
 *    already ran, so it is counted, never refused.
 */
export function checkTransition(transition: CheckedTransition): string[] {
  const { before, after, steps } = transition
  const violations: string[] = []
  let held = ZERO
  let consumed = ZERO
  let recorded = ZERO
  for (const [prior, row] of steps) {
    violations.push(...stepViolations(prior, row))
    held += heldBy(row) - heldBy(prior)
    consumed += consumedBy(row) - consumedBy(prior)
    if (row.kind === "record" && !prior) recorded += row.amount
  }
  if (after.held - before.held !== held) {
    violations.push(`ledger held moved ${after.held - before.held}, rows say ${held}`)
  }
  if (after.held < ZERO) violations.push(`ledger held ${after.held} is negative`)
  violations.push(...counterViolations(transition, consumed))
  for (const limit of transition.resultingLimits) {
    if (limit.enforce !== "hard") continue
    const id = windowIdOf(limit)
    const current = after.usage[id]
    const previous = before.usage[id]
    const priorConsumed = previous?.start === current?.start ? (previous?.consumed ?? ZERO) : ZERO
    const priorExposure = priorConsumed + before.held
    const exposure = (current?.consumed ?? ZERO) + after.held - recorded
    const increasesHardLimitExcess = exposure > limit.amount && exposure > priorExposure
    if (increasesHardLimitExcess) {
      violations.push(`limit ${limit.id} committed ${exposure} beyond ${limit.amount}`)
    }
  }
  return violations
}

/** The hold lifecycle: open -> settled | released, with actual within the hold. */
function stepViolations(prior: Operation | undefined, row: Operation): string[] {
  if (row.kind === "lease") return leaseStepViolations(prior, row)
  const at = `row ${row.id}`
  if (row.amount < ZERO) return [`${at} amount ${row.amount} is negative`]
  if (row.kind !== "hold") return prior ? [`${at} ${row.kind} was written twice`] : []
  const status = row.state.status
  if (!prior) return status === "open" ? [] : [`${at} was created ${status}`]
  if (prior.kind !== "hold" || prior.amount !== row.amount) return [`${at} changed identity`]
  if (prior.state.status !== "open" || status === "open") {
    return [`${at} moved from ${prior.state.status} to ${status}`]
  }
  if (row.state.status === "settled") {
    const { actual } = row.state
    if (actual < ZERO || actual > row.amount) return [`${at} settled ${actual} of ${row.amount}`]
  }
  return []
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

const seqOf = (lease: LeaseOperation) => lease.last?.seq ?? 0

/**
 * The lease lifecycle: created open with nothing captured, or refused with nothing granted; each
 * report is the next seq and only grows `granted` and `captured`, with `captured <= granted`;
 * closing keeps `granted`; expiry keeps the seq and captures all of `granted`; a closed, expired,
 * or refused lease never changes.
 */
function leaseStepViolations(prior: Operation | undefined, row: LeaseOperation): string[] {
  const at = `lease ${row.id}`
  const { granted, captured } = row
  if (granted < ZERO || captured < ZERO || captured > granted) {
    return [`${at} captured ${captured} of ${granted}`]
  }
  if (!prior) {
    const status = row.state.status
    const maxGranted = status === "open" ? row.requested : status === "refused" ? ZERO : null
    const created =
      maxGranted !== null && granted <= maxGranted && captured === ZERO && row.last === null
    return created ? [] : [`${at} was created ${status}`]
  }
  if (
    prior.kind !== "lease" ||
    prior.leaseKey !== row.leaseKey ||
    prior.requested !== row.requested ||
    prior.ttlMs !== row.ttlMs ||
    prior.createdAt !== row.createdAt
  ) {
    return [`${at} changed identity`]
  }
  const status = row.state.status
  if (prior.state.status !== "open") return [`${at} moved from ${prior.state.status} to ${status}`]
  if (granted < prior.granted || captured < prior.captured) return [`${at} shrank`]
  if (status === "expired") {
    const same = seqOf(row) === seqOf(prior) && granted === prior.granted
    return same && captured === granted ? [] : [`${at} expired without capturing its grant`]
  }
  if (seqOf(row) !== seqOf(prior) + 1) {
    return [`${at} skipped from ${seqOf(prior)} to ${seqOf(row)}`]
  }
  if (status === "closed" && granted !== prior.granted) return [`${at} grew as it closed`]
  return []
}
