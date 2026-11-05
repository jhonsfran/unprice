import { publishRateRowsInputSchema } from "@unprice/db/validators"
import { publishRateRows } from "@unprice/services/use-cases"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/**
 * Publishes price rows, and ends the rows of `closeRowIds` where they start, in one write. Without
 * a start they begin at the earliest the card allows: now, or 10 minutes out once a live card has
 * a row.
 */
export const publishRows = protectedProjectProcedure
  .input(publishRateRowsInputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const { features, rateCards } = opts.ctx.services
    const result = await publishRateRows(
      { services: { features, rateCards } },
      { projectId: opts.ctx.project.id, ...opts.input, now: Date.now() }
    )
    if (result.err) throw domainErrorToTrpcError(result.err)
    return result.val
  })
