/** Budget balance rules. */

import type { Amount, SignedAmount } from "@unprice/money"
import { type BudgetConfig, type BudgetRecord, isClosed } from "./config"
import type {
  Blocked,
  BlockedRemedy,
  BudgetBalance,
  BudgetRejection,
  Ledger,
  LimitBalance,
} from "./model"
import { NO_USAGE, type Usage, measured } from "./usage"
import { windowBounds, windowIdOf } from "./windows"

const ZERO = BigInt(0)

export type Funded = Readonly<{ budget: BudgetRecord; ledger: Ledger }>

// Reads

/**
 * Pure read at `now` (clamped to `lastAt`). Windows roll virtually; nothing is written. Each limit
 * reads its own measure of the counter and of what is held.
 */
export function balanceOf(state: Funded, now: number): BudgetBalance {
  const { ledger } = state
  const at = Math.max(now, ledger.lastAt)
  let remaining: SignedAmount | null = null
  const limits = state.budget.config.limits.map((limit): LimitBalance => {
    const { measure } = limit
    const bounds = windowBounds(limit, at)
    const usage = ledger.usage[windowIdOf(limit)]
    const consumed = !usage || bounds.start > usage.start ? ZERO : measured(usage.consumed, measure)
    const held = measured(ledger.held, measure)
    const limitRemaining = limit.amount - consumed - held
    const counts = limit.enforce === "hard" && measure.type === "amount"
    if (counts && (remaining === null || limitRemaining < remaining)) remaining = limitRemaining
    return {
      id: limit.id,
      window: limit.window,
      enforce: limit.enforce,
      measure,
      amount: limit.amount,
      consumed,
      held,
      remaining: limitRemaining,
      resetsAt: bounds.end,
    }
  })
  return { remaining, held: ledger.held, limits, asOf: at }
}

/** The balance a lease sees: quantity limits ignore leases, which reserve the amount only. */
export function amountLimitsOf(balance: BudgetBalance): BudgetBalance {
  return { ...balance, limits: balance.limits.filter((limit) => limit.measure.type === "amount") }
}

/**
 * What would deny a request for `request` at this balance; null when it fits every hard limit that
 * gates it, on that limit's measure.
 */
export function blockingLimit(balance: BudgetBalance, request: Usage): Blocked | null {
  const need = (limit: LimitBalance) => measured(request, limit.measure)
  // A quantity limit gates only requests that carry its feature; an amount limit gates every one.
  const gates = (limit: LimitBalance) => limit.measure.type === "amount" || need(limit) > ZERO
  const failing = balance.limits.filter(
    (limit) => limit.enforce === "hard" && gates(limit) && limit.remaining < need(limit)
  )
  let blocking: LimitBalance | undefined = failing[0]
  if (!blocking) return null
  for (const limit of failing.slice(1)) {
    if (resetsLater(limit.resetsAt, blocking.resetsAt)) blocking = limit
  }
  let remedy: BlockedRemedy = "raise_limit"
  if (failing.every((limit) => limit.consumed + need(limit) <= limit.amount)) {
    remedy = "release_holds"
  } else if (
    failing.every((limit) => limit.resetsAt !== null && limit.held + need(limit) <= limit.amount)
  ) {
    remedy = "wait_for_reset"
  }
  if (remedy === "raise_limit")
    blocking = failing.find((limit) => need(limit) > limit.amount) ?? blocking
  return {
    limitId: blocking.id,
    window: blocking.window,
    remaining: blocking.remaining,
    held: blocking.held,
    resetsAt: blocking.resetsAt,
    remedy,
  }
}

/** Admission for new work. Probes use the same closure and hard-limit policy as authorization. */
export function admissionRejection(
  config: Pick<BudgetConfig, "closesAt">,
  balance: BudgetBalance,
  request: Usage,
  now: number
): Extract<BudgetRejection, { code: "BUDGET_CLOSED" | "LIMIT_EXCEEDED" }> | null {
  if (config.closesAt !== null && isClosed(config, now)) {
    return { code: "BUDGET_CLOSED", closedAt: config.closesAt }
  }
  const blocked = blockingLimit(balance, request)
  return blocked ? { code: "LIMIT_EXCEEDED", blocked, balance } : null
}

/**
 * The amount that fits under every hard amount limit at this balance, never negative; null with no
 * hard amount limit.
 */
export function roomOf(balance: BudgetBalance): Amount | null {
  if (balance.remaining === null) return null
  return balance.remaining > ZERO ? balance.remaining : ZERO
}

function resetsLater(a: number | null, b: number | null): boolean {
  if (b === null) return false
  return a === null || a > b
}

/**
 * Limits whose consumption first exceeds their amount on their measure, after `prior` more was
 * consumed since `balance` was read. A hard limit gets there only after recorded usage took the
 * room its holds and charges were checked against.
 */
export function crossings(balance: BudgetBalance, consumed: Usage, prior = NO_USAGE): string[] {
  return balance.limits
    .filter((limit) => {
      const before = limit.consumed + measured(prior, limit.measure)
      return before <= limit.amount && before + measured(consumed, limit.measure) > limit.amount
    })
    .map((limit) => limit.id)
}
