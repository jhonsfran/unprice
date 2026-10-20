import { budgetKeyInputSchema } from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import { BudgetCatalogServiceError } from "../../budget-catalog"
import { type UnPriceBudgetError, catalogFactsFrom } from "../../budgets"
import type { ServiceContext } from "../../context"
import { bestEffort, isBudgetNotFound } from "./catalog-repair"

export const openBudgetByKeyInputSchema = z.object({
  projectId: z.string(),
  key: budgetKeyInputSchema,
})

export type OpenBudgetByKeyInput = z.infer<typeof openBudgetByKeyInputSchema>

export type OpenBudgetByKeyDeps = {
  services: Pick<ServiceContext, "budgetCatalog" | "budgetOperator">
  logger: Logger
}

/**
 * The catalog id of the budget at a key, asked of its object: registers a budget the catalog
 * missed (one created before the catalog, or whose upsert's catalog write failed).
 */
export async function openBudgetByKey(
  deps: OpenBudgetByKeyDeps,
  input: OpenBudgetByKeyInput
): Promise<Result<{ id: string }, BudgetCatalogServiceError | FetchError | UnPriceBudgetError>> {
  const { budgetCatalog, budgetOperator } = deps.services
  const { projectId, key } = input
  const inspected = await budgetOperator.inspect({ projectId, key })
  if (inspected.err) {
    if (isBudgetNotFound(inspected.err)) {
      await bestEffort(deps.logger, projectId, () => budgetCatalog.forget(projectId, key))
    }
    return inspected
  }

  try {
    await budgetCatalog.record(projectId, catalogFactsFrom(inspected.val.budget))
  } catch (error) {
    deps.logger.error(error instanceof Error ? error : new Error(String(error)), {
      context: "budget catalog write failed",
      projectId,
    })
    return Err(new BudgetCatalogServiceError({ message: "Failed to register the budget" }))
  }
  const row = await budgetCatalog.get(projectId, { key })
  if (row.err) return row
  // `record` only skips writing over an existing row, so the key has one now.
  if (!row.val) throw new Error("budget catalog row missing right after it was recorded")
  return Ok({ id: row.val.id })
}
