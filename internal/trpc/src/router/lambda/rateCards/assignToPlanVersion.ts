import { assignPlanVersionCardInputSchema } from "@unprice/db/validators"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/** Prices a draft plan version in one currency with a card; the card it had there is replaced. */
export const assignToPlanVersion = protectedProjectProcedure
  .input(assignPlanVersionCardInputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const result = await opts.ctx.services.rateCards.assignToPlanVersion(
      opts.ctx.project.id,
      opts.input
    )
    if (result.err) throw domainErrorToTrpcError(result.err)
    return { assignment: result.val }
  })
