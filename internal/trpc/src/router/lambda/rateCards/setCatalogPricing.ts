import { planVersionCatalogPricingInputSchema } from "@unprice/db/validators"
import { setPlanVersionCatalogPricing } from "@unprice/services/use-cases"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/**
 * Prices one plan feature's models from the cost catalog on the version's own card and answers
 * the resulting cost-plus preview, which `publishCostPlus` publishes under its `draftHash`.
 */
export const setCatalogPricing = protectedProjectProcedure
  .input(planVersionCatalogPricingInputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const { plans, features, rateCards } = opts.ctx.services
    const result = await setPlanVersionCatalogPricing(
      { services: { plans, features, rateCards } },
      { ...opts.input, projectId: opts.ctx.project.id, now: Date.now() }
    )
    if (result.err) throw domainErrorToTrpcError(result.err)
    return result.val
  })
