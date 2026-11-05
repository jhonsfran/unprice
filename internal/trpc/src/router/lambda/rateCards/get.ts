import { z } from "zod"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/**
 * The card, every row it ever had, and whether it is live: priced by a version that has been
 * published, so a row change on it takes the notice (ADR-0008 D2).
 */
export const get = protectedProjectProcedure
  .input(z.object({ id: z.string().min(1) }))
  .query(async (opts) => {
    const { rateCards } = opts.ctx.services
    const result = await rateCards.getCard(opts.ctx.project.id, opts.input.id)
    if (result.err) throw domainErrorToTrpcError(result.err)
    return { ...result.val, live: await rateCards.isLive(opts.ctx.project.id, opts.input.id) }
  })
