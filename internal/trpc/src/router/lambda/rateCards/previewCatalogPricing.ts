import { planVersionCatalogPricingInputSchema } from "@unprice/db/validators"
import { previewPlanVersionCatalogPricing } from "@unprice/services/use-cases"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/** Previews one feature's catalog policy without saving its policy or price rows. */
export const previewCatalogPricing = protectedProjectProcedure
  .input(planVersionCatalogPricingInputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const { plans, features, rateCards } = opts.ctx.services
    const result = await previewPlanVersionCatalogPricing(
      { services: { plans, features, rateCards } },
      { ...opts.input, projectId: opts.ctx.project.id, now: Date.now() }
    )
    if (result.err) throw domainErrorToTrpcError(result.err)
    return result.val
  })
