import type { PageCountryVisits } from "@unprice/services/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { WEB_ANALYTICS_UNAVAILABLE, pageVisitsInputSchema } from "./web-analytics-input"

export const getCountryVisits = protectedProjectProcedure
  .input(pageVisitsInputSchema)
  .output(
    z.object({
      data: z.custom<PageCountryVisits>(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const { interval_days, page_id } = opts.input
    const project_id = opts.ctx.project.id
    const { analytics } = opts.ctx.services

    const { err, val } = await analytics.getCountryVisits({
      projectId: project_id,
      pageId: page_id,
      intervalDays: interval_days,
    })

    if (err) {
      return { data: [], error: WEB_ANALYTICS_UNAVAILABLE }
    }

    return val
  })
