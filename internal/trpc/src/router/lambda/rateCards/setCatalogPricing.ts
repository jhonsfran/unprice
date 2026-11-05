import { TRPCError } from "@trpc/server"
import { planVersionCatalogPricingInputSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

/**
 * Prices one plan feature's models from the cost catalog on the version's own card and answers
 * the resulting cost-plus preview, which `publishCostPlus` publishes under its `draftHash`.
 */
export const setCatalogPricing = protectedProjectProcedure
  .input(planVersionCatalogPricingInputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: `catalog pricing for ${opts.input.featureSlug} is not wired yet`,
    })
  })
