import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

/**
 * The cards a plan version prices with, one per currency, and each card's rows in effect now or
 * scheduled to start later: what publishing checks, so the editor and publish agree on what is
 * priced. A row with `effectiveFrom` in the future is a scheduled successor of its match.
 */
export const forPlanVersion = protectedProjectProcedure
  .input(z.object({ planVersionId: z.string().min(1) }))
  .query(async (opts) => {
    const pricing = await opts.ctx.services.rateCards.pricingForPlanVersions(
      opts.ctx.project.id,
      [opts.input.planVersionId],
      Date.now(),
      Number.MAX_SAFE_INTEGER
    )
    return { cards: pricing.get(opts.input.planVersionId) ?? [] }
  })
