import { closeRateRowsInputSchema } from "@unprice/db/validators"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/** Ends open price rows, at least 10 minutes from now; a retry at the same end writes nothing. */
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
