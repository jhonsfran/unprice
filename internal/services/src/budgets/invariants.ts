/** Conservation (ADR-0006 B7.5): what every transition must preserve before it may commit. */

import type { BudgetLimit } from "./config"
import { countersOf, exposureOf } from "./ledger"
import type { LeaseOperation, Ledger, Operation, WindowPeriod } from "./model"
import {
  NO_USAGE,
  type Usage,
  addUsage,
  amountUsage,
  exceededMeasure,
  isNoUsage,
  measureName,
  measured,
  negativeMeasure,
  sameUsage,
  subtractUsage,
} from "./usage"
import { windowIdOf } from "./windows"

const ZERO = BigInt(0)

/** Counted against limits: an open reservation's exposure, else nothing. */
function heldBy(operation: Operation | undefined): Usage {
  return operation?.kind === "hold" || operation?.kind === "lease"
    ? exposureOf(operation)
    : NO_USAGE
}

function consumedBy(operation: Operation | undefined): Usage {
  if (!operation) return NO_USAGE
  if (operation.kind === "lease") return amountUsage(operation.captured)
  if (operation.kind !== "hold") return operation.usage
  return operation.state.status === "settled" ? operation.state.actual : NO_USAGE
}

/** `amount 5, images 2`: a vector in a violation message. */
const show = (usage: Usage) =>
  [`amount ${usage.amount}`, ...Object.entries(usage.quantities).map(([f, q]) => `${f} ${q}`)].join(
    ", "
  )

/** Which measure of `usage` is negative, for a violation message; null when none is. */
function negativeOf(usage: Usage): string | null {
  const measure = negativeMeasure(usage)
  return measure && measureName(measure)
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
 * Every rule holds on every measure: the amount and each feature's quantity.
 * 1. Every row step is legal in its lifecycle, with the hold's and the lease's arithmetic intact.
 * 2. The ledger's held moved by exactly the change in `heldBy` over the touched rows.
 * 3. Per counter, nothing is lost or counted twice: a counter that kept its period grew by exactly
 *    what the rows consumed; one that moved to a new period holds only that, and its old period
 *    is reported when it had usage on a limited window.
 * 4. Held and every counter are non-negative.
 * 5. No hard limit's consumed + held grows past its amount on its measure, except by recorded
 *    usage: that work already ran, so it is counted, never refused.
 */
export function checkTransition(transition: CheckedTransition): string[] {
  const { before, after, steps } = transition
  const violations: string[] = []
  let held = NO_USAGE
  let consumed = NO_USAGE
  let recorded = NO_USAGE
  for (const [prior, row] of steps) {
    violations.push(...stepViolations(prior, row))
    held = addUsage(held, subtractUsage(heldBy(row), heldBy(prior)))
    consumed = addUsage(consumed, subtractUsage(consumedBy(row), consumedBy(prior)))
    if (row.kind === "record" && !prior) recorded = addUsage(recorded, row.usage)
  }
  const moved = subtractUsage(after.held, before.held)
  if (!sameUsage(moved, held)) {
    violations.push(`ledger held moved ${show(moved)}, rows say ${show(held)}`)
  }
  const negativeHeld = negativeOf(after.held)
  if (negativeHeld) violations.push(`ledger held ${negativeHeld} is negative`)
  violations.push(...counterViolations(transition, consumed))
  for (const limit of transition.resultingLimits) {
    if (limit.enforce !== "hard") continue
    const id = windowIdOf(limit)
    const current = after.usage[id]
    const previous = before.usage[id]
    const on = (usage: Usage | undefined) => (usage ? measured(usage, limit.measure) : ZERO)
    const priorConsumed = previous?.start === current?.start ? on(previous?.consumed) : ZERO
    const priorExposure = priorConsumed + on(before.held)
    const exposure = on(current?.consumed) + on(after.held) - on(recorded)
    const increasesHardLimitExcess = exposure > limit.amount && exposure > priorExposure
    if (increasesHardLimitExcess) {
      violations.push(`limit ${limit.id} committed ${exposure} beyond ${limit.amount}`)
    }
  }
  return violations
}

/** The hold lifecycle: open -> settled | released, with actual within the hold on every measure. */
function stepViolations(prior: Operation | undefined, row: Operation): string[] {
  if (row.kind === "lease") return leaseStepViolations(prior, row)
  const at = `row ${row.id}`
  const negative = negativeOf(row.kind === "hold" ? row.reserved : row.usage)
  if (negative) return [`${at} ${negative} is negative`]
  if (row.kind !== "hold") return prior ? [`${at} ${row.kind} was written twice`] : []
  const status = row.state.status
  if (!prior) return status === "open" ? [] : [`${at} was created ${status}`]
  if (prior.kind !== "hold" || !sameUsage(prior.reserved, row.reserved)) {
    return [`${at} changed identity`]
  }
  if (prior.state.status !== "open" || status === "open") {
    return [`${at} moved from ${prior.state.status} to ${status}`]
  }
  if (row.state.status === "settled") {
    const { actual } = row.state
    if (negativeMeasure(actual) || exceededMeasure(actual, row.reserved)) {
      return [`${at} settled ${show(actual)} of ${show(row.reserved)}`]
    }
  }
  return []
}

function counterViolations(
  { before, after, limits, periods }: CheckedTransition,
  consumed: Usage
): string[] {
  const violations: string[] = []
  const limited = new Set(limits.map(windowIdOf))
  const reported = new Map<string, WindowPeriod>()
  for (const period of periods) {
    if (reported.has(period.windowId)) violations.push(`${period.windowId} rolled twice`)
    if (isNoUsage(period.consumed) || negativeMeasure(period.consumed)) {
      violations.push(`${period.windowId} rolled an empty period`)
    }
    if (period.end <= period.start || !after.usage[period.windowId]) {
      violations.push(`${period.windowId} rolled [${period.start}, ${period.end}), not a period`)
    }
    reported.set(period.windowId, period)
  }

  for (const [id, counter] of countersOf(after.usage)) {
    const negative = negativeOf(counter.consumed)
    if (negative) violations.push(`${id} consumed ${negative} is negative`)
    const prior = before.usage[id]
    const period = reported.get(id)
    if (prior && counter.start === prior.start) {
      const expected = addUsage(prior.consumed, consumed)
      if (!sameUsage(counter.consumed, expected)) {
        violations.push(`${id} counted ${show(counter.consumed)}, expected ${show(expected)}`)
      }
      if (period) violations.push(`${id} reported a roll but kept its period`)
      continue
    }
    if (!sameUsage(counter.consumed, consumed)) {
      violations.push(
        `${id} started a period with ${show(counter.consumed)}, expected ${show(consumed)}`
      )
    }
    if (!prior) continue
    if (counter.start < prior.start) violations.push(`${id} rolled backwards`)
    const owed = !isNoUsage(prior.consumed) && limited.has(id)
    if (owed !== (period !== undefined)) violations.push(`${id} rolled without its period`)
    if (period && (period.start !== prior.start || !sameUsage(period.consumed, prior.consumed))) {
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
