import type { Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { type OutcomeOf, type UnPriceBudgetError, catalogFactsOf } from "../../budgets"
import type { ServiceContext } from "../../context"
import {
  type BudgetVerbRequest,
  type ExecuteBudgetCommandDeps,
  type ExecuteBudgetCommandInput,
  executeBudgetCommand,
} from "./execute-budget-command"

export type UpsertBudgetDeps = ExecuteBudgetCommandDeps & {
  services: Pick<ServiceContext, "budgetCatalog">
  // biome-ignore lint/suspicious/noExplicitAny: platform-specific promise handler
  waitUntil: (promise: Promise<any>) => void
  logger: Logger
}

/**
 * Configures the budget, then records its facts in the dashboard catalog after the reply. Run
 * starts upsert a budget each, so the upsert never waits on or fails with Postgres.
 */
export async function upsertBudget(
  deps: UpsertBudgetDeps,
  input: ExecuteBudgetCommandInput<Extract<BudgetVerbRequest, { type: "upsert" }>>
): Promise<Result<OutcomeOf<"upsert">, UnPriceBudgetError>> {
  const result = await executeBudgetCommand({ budgets: deps.budgets }, input)
  if (result.err) return result
  const { changes, budget } = result.val
  // A replay changes nothing. So does creating a budget without limits, at version 1.
  if (changes.length === 0 && budget.version > 1) return result
  deps.waitUntil(
    deps.services.budgetCatalog
      .record(input.projectId, catalogFactsOf(budget))
      .catch((error: unknown) => {
        deps.logger.error(error instanceof Error ? error : new Error(String(error)), {
          context: "budget catalog write failed",
          projectId: input.projectId,
          version: budget.version,
        })
      })
  )
  return result
}
