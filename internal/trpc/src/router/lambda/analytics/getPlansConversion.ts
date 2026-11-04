import type { PlansConversion } from "@unprice/services/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { intervalDaysSchema } from "./web-analytics-input"

export const getPlansConversion = protectedProjectProcedure
  .input(z.object({ interval_days: intervalDaysSchema }))
  .output(
    z.object({
      data: z.custom<PlansConversion>(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const { err, val } = await opts.ctx.services.analytics.getPlansConversion({
      projectId: opts.ctx.project.id,
      intervalDays: opts.input.interval_days,
    })

    if (err) {
      return { data: [], error: err.message }
    }

    return val
  })
