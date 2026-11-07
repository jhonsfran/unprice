import { customModelCostInputSchema } from "@unprice/db/validators"
import {
  addCustomModelCost as addCustomModelCostUseCase,
  listCustomModelCosts as listCustomModelCostsUseCase,
} from "@unprice/services/use-cases"
import { protectedProjectProcedure } from "#trpc"

/** The project's own models in its cost catalog, each at its newest cost. */
export const listCustomModels = protectedProjectProcedure.query(async (opts) => {
  const { rateCards } = opts.ctx.services
  return {
    costs: await listCustomModelCostsUseCase(
      { services: { rateCards } },
      { projectId: opts.ctx.project.id }
    ),
  }
})

/**
 * Adds a model to the project's cost catalog, or a newer cost for one there. Prices follow on the
 * next catalog preview, as a change the operator applies.
 */
export const addCustomModel = protectedProjectProcedure
  .input(customModelCostInputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const { rateCards } = opts.ctx.services
    const cost = await addCustomModelCostUseCase(
      { services: { rateCards } },
      { ...opts.input, projectId: opts.ctx.project.id, now: Date.now() }
    )
    return { cost }
  })
