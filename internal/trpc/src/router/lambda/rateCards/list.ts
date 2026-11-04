import { protectedProjectProcedure } from "#trpc"

export const list = protectedProjectProcedure.query(async (opts) => {
  return { cards: await opts.ctx.services.rateCards.listCards(opts.ctx.project.id) }
})
