import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "@unprice/services/context"
import {
  type SyncPayerBudgetDeps,
  rateCardSource,
  walletFunding,
} from "@unprice/services/use-cases"
import type { Env } from "~/env"
import { CloudflareBudgetClient } from "./client"

/**
 * What `syncPayerBudget` needs in the API worker: the budget's Durable Object reached directly,
 * because `runBudgetVerb` refuses to define an `unprice:` key (ADR-0008 D1).
 */
export function payerBudgetSyncDeps(input: {
  env: Pick<Env, "APP_ENV" | "budget">
  db: Database
  services: Pick<ServiceContext, "budgetCatalog" | "rateCards" | "wallet">
  logger: Logger
  // biome-ignore lint/suspicious/noExplicitAny: platform-specific promise handler
  waitUntil: (promise: Promise<any>) => void
}): SyncPayerBudgetDeps {
  const { budgetCatalog, rateCards, wallet } = input.services
  return {
    db: input.db,
    budgets: new CloudflareBudgetClient(input.env),
    cards: rateCardSource(rateCards),
    wallet: walletFunding(wallet),
    services: { budgetCatalog, rateCards },
    logger: input.logger,
    waitUntil: input.waitUntil,
  }
}
