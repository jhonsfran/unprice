import { applyPlanVersionCatalogPricingInputSchema } from "@unprice/db/validators"
import { applyPlanVersionCatalogPricing } from "@unprice/services/use-cases"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

export const applyCatalogPricing = protectedProjectProcedure
  .input(applyPlanVersionCatalogPricingInputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const { plans, features, rateCards } = opts.ctx.services
    const result = await applyPlanVersionCatalogPricing(
      { db: opts.ctx.db, services: { plans, features, rateCards } },
      { ...opts.input, projectId: opts.ctx.project.id, now: Date.now() }
    )
    if (result.err) throw domainErrorToTrpcError(result.err)
    return result.val
  })
