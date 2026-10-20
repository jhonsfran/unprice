import type { Result } from "@unprice/error"
import { type OutcomeOf, type UnPriceBudgetError, catalogFactsOf } from "../../budgets"
import {
  type BudgetVerbRequest,
  type ExecuteBudgetCommandInput,
  executeBudgetCommand,
} from "./execute-budget-command"
import type { UpsertBudgetDeps } from "./upsert-budget"

export type CreatingVerbRequest = Extract<BudgetVerbRequest, { ifMissing?: unknown }>

/**
 * Runs a verb that may create its budget on first use (ADR-0006 D8), then records a created
 * budget in the dashboard catalog after the reply, as an upsert does.
 */
export async function executeCreatingVerb<R extends CreatingVerbRequest>(
  deps: UpsertBudgetDeps,
  input: ExecuteBudgetCommandInput<R>
): Promise<Result<OutcomeOf<R["type"]>, UnPriceBudgetError>> {
  const result = await executeBudgetCommand({ budgets: deps.budgets }, input)
  if (result.err) return result
  const { created } = result.val
  if (!created) return result
  deps.waitUntil(
    deps.services.budgetCatalog
      .record(input.projectId, catalogFactsOf(created))
      .catch((error: unknown) => {
        deps.logger.error(error instanceof Error ? error : new Error(String(error)), {
          context: "budget catalog write failed",
          projectId: input.projectId,
          version: created.version,
        })
      })
  )
  return result
}
