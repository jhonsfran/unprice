import { closeRateRowsInputSchema } from "@unprice/db/validators"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/**
 * Ends open price rows, at the earliest the card allows when no end is given (10 minutes out on
 * a live card); a retry writes nothing.
 */
export const closeRows = protectedProjectProcedure
  .input(closeRateRowsInputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const result = await opts.ctx.services.rateCards.closeRows({
      projectId: opts.ctx.project.id,
      ...opts.input,
      now: Date.now(),
    })
    if (result.err) throw domainErrorToTrpcError(result.err)
    return result.val
  })
