import { z } from "zod"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/** The card's cost-plus revision as of now, and the hash `publishCostPlus` must be given. */
export const previewCostPlus = protectedProjectProcedure
  .input(z.object({ cardId: z.string().min(1) }))
  .query(async (opts) => {
    const result = await opts.ctx.services.rateCards.previewCostPlus(
      opts.ctx.project.id,
      opts.input.cardId,
      Date.now()
    )
    if (result.err) throw domainErrorToTrpcError(result.err)
    return result.val
  })
