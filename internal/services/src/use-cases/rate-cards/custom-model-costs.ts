import type { CustomModelCost, customModelCostInputSchema } from "@unprice/db/validators"
import type { z } from "zod"
import type { ServiceContext } from "../../context"

export type CustomModelCostsDeps = {
  services: Pick<ServiceContext, "rateCards">
}

export type AddCustomModelCostInput = z.infer<typeof customModelCostInputSchema> & {
  projectId: string
  now: number
}

/**
 * Adds a model to a project's own cost catalog, or a newer cost for one already there, effective
 * now. Every card of the project with a cost-plus policy then drafts it at cost plus the feature's
 * markup on its next preview; a model models.dev also lists is priced from this cost instead.
 */
export async function addCustomModelCost(
  deps: CustomModelCostsDeps,
  input: AddCustomModelCostInput
): Promise<CustomModelCost> {
  const { projectId, now, ...cost } = input
  return deps.services.rateCards.insertCustomModelCost(projectId, { ...cost, effectiveFrom: now })
}

/** A project's custom models, each at its newest cost. */
export async function listCustomModelCosts(
  deps: CustomModelCostsDeps,
  input: { projectId: string }
): Promise<CustomModelCost[]> {
  return deps.services.rateCards.customModelCosts(input.projectId)
}
