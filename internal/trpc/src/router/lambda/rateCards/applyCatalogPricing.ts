import { applyPlanVersionCatalogPricingInputSchema } from "@unprice/db/validators"
import { applyPlanVersionCatalogPricing } from "@unprice/services/use-cases"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

export const applyCatalogPricing = protectedProjectProcedure
  .input(applyPlanVersionCatalogPricingInputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const { plans, rateCards, modelCosts } = opts.ctx.services
    const result = await applyPlanVersionCatalogPricing(
      { db: opts.ctx.db, services: { plans, rateCards, modelCosts } },
      { ...opts.input, projectId: opts.ctx.project.id, now: Date.now() }
    )
    if (result.err) throw domainErrorToTrpcError(result.err)
    return result.val
  })
