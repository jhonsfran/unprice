import { publishCostPlusInputSchema } from "@unprice/db/validators"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/** Publishes the previewed cost-plus revision; a changed draft is CONFLICT. */
export const publishCostPlus = protectedProjectProcedure
  .input(publishCostPlusInputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const result = await opts.ctx.services.rateCards.publishCostPlus({
      projectId: opts.ctx.project.id,
      ...opts.input,
      now: Date.now(),
    })
    if (result.err) throw domainErrorToTrpcError(result.err)
    return result.val
  })
