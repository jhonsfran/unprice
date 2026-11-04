import { z } from "zod"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/** The card and every row it ever had. */
export const get = protectedProjectProcedure
  .input(z.object({ id: z.string().min(1) }))
  .query(async (opts) => {
    const result = await opts.ctx.services.rateCards.getCard(opts.ctx.project.id, opts.input.id)
    if (result.err) throw domainErrorToTrpcError(result.err)
    return result.val
  })
