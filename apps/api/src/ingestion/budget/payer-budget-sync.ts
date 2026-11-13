import type { Database } from "@unprice/db"
import type { SyncPayerBudgetDeps } from "@unprice/services/use-cases"
import { budgetCommandDeps } from "./deps"

/**
 * What `syncPayerBudget` needs in the API worker: the budget's Durable Object reached directly,
 * because `runBudgetVerb` refuses to define an `unprice:` key (ADR-0008 D1).
 */
export function payerBudgetSyncDeps(
  input: Parameters<typeof budgetCommandDeps>[0] & { db: Database }
): SyncPayerBudgetDeps {
  return {
    ...budgetCommandDeps(input),
    db: input.db,
    services: { budgetCatalog: input.services.budgetCatalog, rateCards: input.services.rateCards },
  }
}
