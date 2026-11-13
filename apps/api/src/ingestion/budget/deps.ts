import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "@unprice/services/context"
import type { BudgetClient } from "@unprice/services/use-cases"
import {
  type ExecuteBudgetCommandDeps,
  rateCardSource,
  walletFunding,
} from "@unprice/services/use-cases"
import type { Context } from "hono"
import type { Env } from "~/env"
import type { HonoEnv } from "~/hono/env"
import { CloudflareBudgetClient } from "./client"

/** The API worker's shared dependencies for budget commands and payer sync. */
export function budgetCommandDeps(input: {
  budgets?: BudgetClient
  env: Pick<Env, "APP_ENV" | "budget">
  services: Pick<ServiceContext, "budgetCatalog" | "rateCards" | "wallet">
  logger: Logger
  waitUntil: (promise: Promise<unknown>) => void
}): ExecuteBudgetCommandDeps & { budgets: BudgetClient } {
  const { budgetCatalog, rateCards, wallet } = input.services
  return {
    budgets: input.budgets ?? new CloudflareBudgetClient(input.env),
    cards: rateCardSource(rateCards),
    wallet: walletFunding(wallet),
    services: { budgetCatalog },
    logger: input.logger,
    waitUntil: input.waitUntil,
  }
}

/** Reuses the same budget client, card source, and wallet for this request. */
export function requestBudgetCommandDeps(
  c: Context<HonoEnv>
): ExecuteBudgetCommandDeps & { budgets: BudgetClient } {
  const existing = c.get("budgetDeps")
  if (existing) return existing
  const deps = budgetCommandDeps({
    env: c.env,
    services: c.get("services"),
    logger: c.get("logger"),
    waitUntil: c.get("waitUntil"),
  })
  c.set("budgetDeps", deps)
  return deps
}
