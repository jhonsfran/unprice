import { previewCostPlusInputSchema } from "@unprice/db/validators"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/** The card's cost-plus revision at `at` (now by default), and the hash `publishCostPlus` needs. */
export const previewCostPlus = protectedProjectProcedure
  .input(previewCostPlusInputSchema)
  .query(async (opts) => {
    const result = await opts.ctx.services.rateCards.previewCostPlus(
      opts.ctx.project.id,
      opts.input.cardId,
      opts.input.at ?? Date.now()
    )
    if (result.err) throw domainErrorToTrpcError(result.err)
    return result.val
  })
