import { createRateCardInputSchema } from "@unprice/db/validators"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

export const create = protectedProjectProcedure
  .input(createRateCardInputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const result = await opts.ctx.services.rateCards.createCard(opts.ctx.project.id, opts.input)
    if (result.err) throw domainErrorToTrpcError(result.err)
    return { card: result.val }
  })
