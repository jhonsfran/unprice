import { TRPCError } from "@trpc/server"
import { type Interval, statsSchema } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getPlansStats = protectedProjectProcedure
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
    const projectId = opts.ctx.project.id
    const interval = opts.input.interval
    const { analytics } = opts.ctx.services

    const { val: stats, err } = await analytics.getPlansStats({
      projectId,
      interval,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return { stats }
  })
