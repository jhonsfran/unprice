import { publishRateRowsInputSchema } from "@unprice/db/validators"
import { publishRateRows } from "@unprice/services/use-cases"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/**
 * Publishes price rows, and ends the rows of `closeRowIds` where they start, in one write; once
 * the card has a row, every start and end is at least 10 minutes from now.
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
