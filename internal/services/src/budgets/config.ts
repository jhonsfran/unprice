/** Budget config (ADR-0006 B1): the stored record, and the audit of an upsert. */

import { type BudgetConfig, CLOSED_BUDGET_RETENTION_MS } from "@unprice/db/validators"
import type { Amount } from "@unprice/money"

// The wire schema parses a config into these types; the timing constants live with it, whose
// descriptions state them.
export type { BudgetConfig, BudgetConfigInput, BudgetOperations } from "@unprice/db/validators"
export {
  CLOSED_BUDGET_RETENTION_MS,
  DEFAULT_HOLD_TTL_MS,
  LEASE_REFUSAL_RETENTION_MS,
  MAX_HOLD_TTL_MS,
  MAX_RETAINED_ANCHORED_WINDOWS,
  MIN_HOLD_TTL_MS,
  OPERATION_RETENTION_MS,
  RECORD_ACCEPT_WINDOW_MS,
  RECORD_DEDUPE_MS,
  RECORD_FUTURE_SKEW_MS,
  WINDOW_HISTORY_PERIODS,
  formatBudgetConfig,
} from "@unprice/db/validators"

export type BudgetLimit = BudgetConfig["limits"][number]

/**
 * True from `closesAt + graceMs` on. Authorize and charge are refused from `closesAt`, `record`
 * from `closesAt + OPERATION_RETENTION_MS`.
 */
export function isClosed(config: BudgetConfig, now: number, graceMs = 0): boolean {
  return config.closesAt !== null && now >= config.closesAt + graceMs
}

/**
 * When a closed budget may delete its storage, CLOSED_BUDGET_RETENTION_MS after `closesAt`; null
 * for a budget that never closes. The alarm deletes it only once no row is left.
 */
export function deletableAt(config: BudgetConfig): number | null {
  return config.closesAt === null ? null : config.closesAt + CLOSED_BUDGET_RETENTION_MS
}

export type BudgetRecord = Readonly<{
  key: string
  projectId: string
  /** `money:<ISO currency> | credits:<id> | units:<slug>`, validated at the API boundary. */
  unit: string
  version: number
  config: BudgetConfig
}>

/** Audit trail of an upsert (B1: changing `enforce` writes an audit entry). */
export type ConfigChange =
  | Readonly<{ change: "limit.added"; limitId: string }>
  | Readonly<{ change: "limit.removed"; limitId: string }>
  | Readonly<{ change: "limit.amount"; limitId: string; from: Amount; to: Amount }>
  | Readonly<{
      change: "limit.enforce"
      limitId: string
      from: BudgetLimit["enforce"]
      to: BudgetLimit["enforce"]
    }>
  | Readonly<{ change: "limits.order" }>
  | Readonly<{ change: "holds" }>
  | Readonly<{ change: "closesAt" }>

export function diffConfig(prev: BudgetConfig, next: BudgetConfig): ConfigChange[] {
  const changes: ConfigChange[] = []
  const prevById = new Map(prev.limits.map((limit) => [limit.id, limit]))
  const nextIds = new Set(next.limits.map((limit) => limit.id))

  for (const limit of next.limits) {
    const before = prevById.get(limit.id)
    if (!before) {
      changes.push({ change: "limit.added", limitId: limit.id })
      continue
    }
    if (before.amount !== limit.amount) {
      changes.push({
        change: "limit.amount",
        limitId: limit.id,
        from: before.amount,
        to: limit.amount,
      })
    }
    if (before.enforce !== limit.enforce) {
      changes.push({
        change: "limit.enforce",
        limitId: limit.id,
        from: before.enforce,
        to: limit.enforce,
      })
    }
  }
  for (const limit of prev.limits) {
    if (!nextIds.has(limit.id)) changes.push({ change: "limit.removed", limitId: limit.id })
  }

  const kept = prev.limits.filter((limit) => nextIds.has(limit.id)).map((limit) => limit.id)
  const keptInNext = next.limits.filter((limit) => prevById.has(limit.id)).map((limit) => limit.id)
  if (kept.join("\n") !== keptInNext.join("\n")) changes.push({ change: "limits.order" })

  if (
    prev.holds.defaultTtlMs !== next.holds.defaultTtlMs ||
    prev.holds.maxTtlMs !== next.holds.maxTtlMs
  ) {
    changes.push({ change: "holds" })
  }
  if (prev.closesAt !== next.closesAt) changes.push({ change: "closesAt" })
  return changes
}

/**
 * The first change that lets more spend through: a hard limit removed, raised, or made soft, or a
 * close time cleared or postponed. Null when `next` only keeps or tightens what `prev` enforced.
 * Soft limits and hold TTLs never deny, so changing them loosens nothing.
 */
export function loosening(prev: BudgetConfig, next: BudgetConfig): ConfigChange | null {
  const nextById = new Map(next.limits.map((limit) => [limit.id, limit]))
  for (const before of prev.limits) {
    if (before.enforce !== "hard") continue
    const after = nextById.get(before.id)
    if (!after) return { change: "limit.removed", limitId: before.id }
    if (after.enforce !== "hard") {
      return { change: "limit.enforce", limitId: before.id, from: "hard", to: after.enforce }
    }
    if (after.amount > before.amount) {
      return { change: "limit.amount", limitId: before.id, from: before.amount, to: after.amount }
    }
  }
  const postponed =
    prev.closesAt !== null && (next.closesAt === null || next.closesAt > prev.closesAt)
  return postponed ? { change: "closesAt" } : null
}

/**
 * The close a caller that may not loosen gets: never before `now`, or before a close the budget
 * already passed. A close in the past would bring forward the deletion that follows it, after which
 * an upsert creates the budget anew without its caps.
 */
export function closeNoEarlierThanNow(
  prev: BudgetConfig,
  next: BudgetConfig,
  now: number
): BudgetConfig {
  if (next.closesAt === null) return next
  const floor = prev.closesAt === null ? now : Math.min(prev.closesAt, now)
  return next.closesAt >= floor ? next : { ...next, closesAt: floor }
}
