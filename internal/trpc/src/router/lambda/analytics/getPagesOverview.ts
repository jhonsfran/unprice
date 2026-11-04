import type { PageOverview } from "@unprice/services/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { pageVisitsInputSchema } from "./web-analytics-input"

export const getPagesOverview = protectedProjectProcedure
  .input(pageVisitsInputSchema)
  .output(
    z.object({
      data: z.custom<PageOverview>(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const { interval_days, page_id } = opts.input
    const project_id = opts.ctx.project.id
    const { analytics } = opts.ctx.services

    const { err, val } = await analytics.getPagesOverview({
      projectId: project_id,
      pageId: page_id,
      intervalDays: interval_days,
    })

    if (err) {
      return { data: [], error: err.message }
    }

    return val
  })
