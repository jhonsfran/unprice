import { publishRateRowsInputSchema } from "@unprice/db/validators"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/**
 * Publishes price rows, and ends the rows of `closeRowIds` where they start, in one write. Without
 * a start they begin at the earliest the card allows: now, or 10 minutes ahead on a live card.
 */
export const publishRows = protectedProjectProcedure
  .input(publishRateRowsInputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const result = await opts.ctx.services.rateCards.publishRows({
      projectId: opts.ctx.project.id,
      ...opts.input,
      drafts: opts.input.rows,
      now: Date.now(),
    })
    if (result.err) throw domainErrorToTrpcError(result.err)
    return result.val
  })
