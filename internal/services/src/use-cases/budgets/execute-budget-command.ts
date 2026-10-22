import { Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import {
  type BudgetDefinition,
  type OutcomeOf,
  type UnPriceBudgetError,
  catalogFactsOf,
  isOutcomeOf,
} from "../../budgets"
import type { ServiceContext } from "../../context"
import type { BudgetClient, BudgetRequest } from "./budget-client"

/** The budget a verb creates when its key has none, before the address is added to it. */
export type BudgetDefinitionInput = Omit<BudgetDefinition, "key" | "projectId">

type Addressed<T> = T extends { ifMissing?: BudgetDefinition }
  ? Omit<T, "ifMissing"> & { ifMissing?: BudgetDefinitionInput }
  : T

/**
 * A verb as an adapter receives it, already parsed by the `@unprice/db/validators` schemas. The
 * key travels beside it: an upsert takes its key and project from the address, and so does the
 * `ifMissing` definition of a verb that creates its budget on first use.
 */
export type BudgetVerbRequest =
  | Omit<Extract<BudgetRequest, { type: "upsert" }>, "key" | "projectId">
  | Addressed<Exclude<BudgetRequest, { type: "upsert" }>>

export type ExecuteBudgetCommandDeps = {
  budgets: BudgetClient
  services: Pick<ServiceContext, "budgetCatalog">
  logger: Logger
  waitUntil: (promise: Promise<unknown>) => void
}

export type ExecuteBudgetCommandInput<R extends BudgetVerbRequest = BudgetVerbRequest> = {
  projectId: string
  key: string
  request: R
}

function toCommand(request: BudgetVerbRequest, projectId: string, key: string): BudgetRequest {
  if (request.type === "upsert") return { ...request, key, projectId }
  if ("ifMissing" in request && request.ifMissing) {
    return { ...request, ifMissing: { ...request.ifMissing, key, projectId } }
  }
  return request as BudgetRequest
}

/**
 * The one owner of every budget verb: the API routes call it now, ingestion `record` and
 * subscription-created budgets later. An upsert always configures the budget at the address it
 * is sent to. Configured or newly created budget facts reach the catalog through `waitUntil`.
 */
export async function executeBudgetCommand<R extends BudgetVerbRequest>(
  deps: ExecuteBudgetCommandDeps,
  input: ExecuteBudgetCommandInput<R>
): Promise<Result<OutcomeOf<R["type"]>, UnPriceBudgetError>> {
  const { projectId, key } = input
  const command = toCommand(input.request, projectId, key)
  const result = await deps.budgets.execute({ projectId, key }, command)
  if (result.err) return result
  // RPC erases the verb's type; the budget always answers with the outcome of the verb it ran.
  if (!isOutcomeOf(result.val, input.request.type)) {
    throw new Error(`budget ${input.request.type} returned a ${result.val.type} outcome`)
  }
  const outcome = result.val
  const budget =
    outcome.type === "upsert"
      ? outcome.changes.length > 0 || outcome.budget.version === 1
        ? outcome.budget
        : null
      : "created" in outcome
        ? outcome.created
        : null
  if (budget) {
    deps.waitUntil(
      deps.services.budgetCatalog
        .record(projectId, catalogFactsOf(budget))
        .catch((error: unknown) => {
          deps.logger.error(error instanceof Error ? error : new Error(String(error)), {
            context: "budget catalog write failed",
            projectId,
            version: budget.version,
          })
        })
    )
  }
  return Ok(outcome)
}
