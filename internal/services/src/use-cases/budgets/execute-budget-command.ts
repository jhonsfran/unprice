import { Ok, type Result } from "@unprice/error"
import { type OutcomeOf, type UnPriceBudgetError, isOutcomeOf } from "../../budgets"
import type { BudgetClient, BudgetRequest } from "./budget-client"

/**
 * A verb as an adapter receives it, already parsed by the `@unprice/db/validators` schemas. The
 * key travels beside it, and an upsert takes its key and project from the address.
 */
export type BudgetVerbRequest =
  | Omit<Extract<BudgetRequest, { type: "upsert" }>, "key" | "projectId">
  | Exclude<BudgetRequest, { type: "upsert" }>

export type ExecuteBudgetCommandDeps = { budgets: BudgetClient }

export type ExecuteBudgetCommandInput<R extends BudgetVerbRequest = BudgetVerbRequest> = {
  projectId: string
  key: string
  request: R
}

/**
 * The one owner of every budget verb: the API routes call it now, ingestion `record` and
 * subscription-created budgets later. An upsert always configures the budget at the address it
 * is sent to.
 */
export async function executeBudgetCommand<R extends BudgetVerbRequest>(
  deps: ExecuteBudgetCommandDeps,
  input: ExecuteBudgetCommandInput<R>
): Promise<Result<OutcomeOf<R["type"]>, UnPriceBudgetError>> {
  const { projectId, key } = input
  const request: BudgetVerbRequest = input.request
  const command: BudgetRequest =
    request.type === "upsert" ? { ...request, key, projectId } : request
  const result = await deps.budgets.execute({ projectId, key }, command)
  if (result.err) return result
  // RPC erases the verb's type; the budget always answers with the outcome of the verb it ran.
  if (!isOutcomeOf(result.val, input.request.type)) {
    throw new Error(`budget ${input.request.type} returned a ${result.val.type} outcome`)
  }
  return Ok(result.val)
}
