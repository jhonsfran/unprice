import { type Interval, statsSchema } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getOverviewStats = protectedProjectProcedure
  .input(
    z.object({
      interval: z.custom<Interval>(),
    })
  )
  .output(
    z.object({
      stats: statsSchema,
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const project_id = opts.ctx.project.id
    const interval = opts.input.interval
    const { analytics } = opts.ctx.services

    const { err, val: stats } = await analytics.getOverviewStats({
      projectId: project_id,
      defaultCurrency: opts.ctx.project.defaultCurrency,
      interval,
    })

    if (err) {
      return { stats: {}, error: err.message }
    }

    return { stats }
  })
