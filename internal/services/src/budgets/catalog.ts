/** What the dashboard catalog stores about a budget: configuration facts, never a balance. */

import type {
  BudgetCap,
  BudgetCatalogFacts,
  BudgetCatalogLimit,
  BudgetCatalogStatus,
} from "@unprice/db/validators"
import { formatBudgetConfig } from "./config"
import type { BudgetSnapshot } from "./model"

export type { BudgetCap, BudgetCatalogFacts, BudgetCatalogLimit, BudgetCatalogStatus }

/** The catalog facts of a committed budget, as an upsert returns it. */
export function catalogFactsOf(budget: BudgetSnapshot): BudgetCatalogFacts {
  return catalogFactsFrom({ ...budget, limits: formatBudgetConfig(budget).limits })
}

/** The catalog facts of a budget whose config is already formatted, as the wire carries it. */
export function catalogFactsFrom(
  budget: Pick<BudgetCatalogFacts, "key" | "unit" | "version" | "closesAt"> &
    Readonly<{ limits: readonly BudgetCatalogLimit[] }>
): BudgetCatalogFacts {
  const limits = budget.limits.map(({ id, window, enforce, amount }) => ({
    id,
    window,
    enforce,
    amount,
  }))
  return {
    key: budget.key,
    unit: budget.unit,
    version: budget.version,
    cap: capOf(limits),
    limits,
    closesAt: budget.closesAt,
  }
}

function capOf(limits: readonly BudgetCatalogLimit[]): BudgetCap {
  if (limits.some((limit) => limit.enforce === "hard")) return "hard"
  return limits.length > 0 ? "soft" : "none"
}

export function catalogStatusOf(closesAt: number | null, now: number): BudgetCatalogStatus {
  if (closesAt === null) return "open"
  return closesAt > now ? "closing" : "closed"
}
