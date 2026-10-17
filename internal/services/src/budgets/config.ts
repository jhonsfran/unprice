/** Budget config (ADR-0006 B1): the stored record, and the audit of an upsert. */

import type { BudgetConfig } from "@unprice/db/validators"
import type { Amount } from "@unprice/money"

// The wire schema parses a config into these types; the timing constants live with it, whose
// descriptions state them.
export type { BudgetConfig, BudgetConfigInput } from "@unprice/db/validators"
export {
  DEFAULT_HOLD_TTL_MS,
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
