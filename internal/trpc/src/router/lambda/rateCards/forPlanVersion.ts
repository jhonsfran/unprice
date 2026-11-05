import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

/** The cards a plan version prices with, one per currency, and each card's rows in effect now. */
export const forPlanVersion = protectedProjectProcedure
  .input(z.object({ planVersionId: z.string().min(1) }))
  .query(async (opts) => {
    const pricing = await opts.ctx.services.rateCards.pricingForPlanVersions(
      opts.ctx.project.id,
      [opts.input.planVersionId],
      Date.now()
    )
    return { cards: pricing.get(opts.input.planVersionId) ?? [] }
  })
