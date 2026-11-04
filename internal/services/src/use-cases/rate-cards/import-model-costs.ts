import { MODEL_CATALOG, MODEL_CATALOG_VERSION } from "../../budgets/model-catalog"
import type { ServiceContext } from "../../context"
import { catalogCosts, changedCosts } from "../../rate-cards/model-costs"

export type ImportModelCostsDeps = {
  services: Pick<ServiceContext, "rateCards">
}

/**
 * Imports the generated models.dev catalog into `model_costs`: a model gets a new `modelsdev` row
 * only when its components differ from its latest one. Manual rows are never read or written, so
 * a manual cost keeps winning wherever costs are resolved.
 */
export async function importModelCosts(
  deps: ImportModelCostsDeps,
  input: { now: number }
): Promise<{ inserted: number; unchanged: number }> {
  const { rateCards } = deps.services
  const proposed = catalogCosts(MODEL_CATALOG, MODEL_CATALOG_VERSION, input.now)
  const changed = changedCosts(await rateCards.latestImportedCosts(), proposed)
  const inserted = await rateCards.insertModelCosts(changed)
  return { inserted, unchanged: proposed.length - inserted }
}
