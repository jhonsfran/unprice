import { customModelCostInputSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

/** The project's own models in its cost catalog, each at its newest cost. */
export const listCustomModels = protectedProjectProcedure.query(async (opts) => {
  return { costs: await opts.ctx.services.modelCosts.listCustom(opts.ctx.project.id) }
})

/**
 * Adds a model to the project's cost catalog, or a newer cost for one there. Prices follow on the
 * next catalog preview, as a change the operator applies.
 */
export const addCustomModel = protectedProjectProcedure
  .input(customModelCostInputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const cost = await opts.ctx.services.modelCosts.addCustom(
      opts.ctx.project.id,
      opts.input,
      Date.now()
    )
    return { cost }
  })
