import { previewCostPlusInputSchema } from "@unprice/db/validators"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/**
 * The card's cost-plus revision at `at` (now by default). `publishCostPlus` recomputes the
 * revision at its own now, so only a preview at now carries the `draftHash` it needs; a preview at
 * a chosen `at` is a what-if and its `draftHash` is null.
 */
export const previewCostPlus = protectedProjectProcedure
  .input(previewCostPlusInputSchema)
  .query(async (opts) => {
    const result = await opts.ctx.services.rateCards.previewCostPlus(
      opts.ctx.project.id,
      opts.input.cardId,
      opts.input.at ?? Date.now(),
      { featureSlug: opts.input.featureSlug }
    )
    if (result.err) throw domainErrorToTrpcError(result.err)
    const { draft, draftHash } = result.val
    return { draft, draftHash: opts.input.at === undefined ? draftHash : null }
  })
