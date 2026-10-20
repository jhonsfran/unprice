import {
  budgetCatalogRowSchema,
  inspectBudgetQuerySchema,
  inspectBudgetResponseSchema,
} from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { BudgetCatalogServiceError } from "../../budget-catalog"
import { UnPriceBudgetError, catalogFactsFrom, catalogStatusOf } from "../../budgets"
import type { ServiceContext } from "../../context"
import { bestEffort, isBudgetNotFound } from "./catalog-repair"

export const inspectBudgetInputSchema = z.object({
  projectId: z.string(),
  id: z.string(),
  query: inspectBudgetQuerySchema,
})

/** The live inspection, and the catalog row as read-repair left it. */
export const inspectBudgetOutputSchema = inspectBudgetResponseSchema.extend({
  catalog: budgetCatalogRowSchema,
})

export type InspectBudgetInput = z.infer<typeof inspectBudgetInputSchema>
export type InspectBudgetOutput = z.infer<typeof inspectBudgetOutputSchema>

export type InspectBudgetDeps = {
  services: Pick<ServiceContext, "budgetCatalog" | "budgetOperator">
  logger: Logger
}

/**
 * Inspects the budget behind a catalog id and repairs the catalog from what its object answers:
 * newer facts are recorded, and a key whose object has no budget any more is forgotten. A failed
 * repair is logged and never hides the live answer.
 */
export async function inspectBudget(
  deps: InspectBudgetDeps,
  input: InspectBudgetInput
): Promise<
  Result<InspectBudgetOutput, BudgetCatalogServiceError | FetchError | UnPriceBudgetError>
> {
  const { budgetCatalog, budgetOperator } = deps.services
  const { projectId, id, query } = input
  const found = await budgetCatalog.get(projectId, { id })
  if (found.err) return found
  const row = found.val
  if (!row) return Err(new UnPriceBudgetError({ code: "BUDGET_NOT_FOUND" }))

  const inspected = await budgetOperator.inspect({ projectId, key: row.key, ...query })
  if (inspected.err) {
    if (isBudgetNotFound(inspected.err)) {
      await bestEffort(deps.logger, projectId, () => budgetCatalog.forget(projectId, row.key))
    }
    return inspected
  }
  const { budget } = inspected.val
  if (budget.version === row.version) return Ok({ ...inspected.val, catalog: row })

  const facts = catalogFactsFrom(budget)
  await bestEffort(deps.logger, projectId, () => budgetCatalog.record(projectId, facts))
  const status = catalogStatusOf(facts.closesAt, Date.now())
  return Ok({ ...inspected.val, catalog: { ...row, ...facts, status } })
}
