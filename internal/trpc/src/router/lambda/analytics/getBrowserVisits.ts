import type { Analytics, PageBrowserVisits } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getBrowserVisits = protectedProjectProcedure
  .input(z.custom<Parameters<Analytics["getBrowserVisits"]>[0]>())
  .output(
    z.object({
      data: z.custom<PageBrowserVisits>(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const { interval_days, page_id } = opts.input
    const project_id = opts.ctx.project.id
    const { analytics } = opts.ctx.services

    const { err, val } = await analytics.getBrowserVisits({
      projectId: project_id,
      pageId: page_id,
      intervalDays: interval_days,
    })

    if (err) {
      return { data: [], error: err.message }
    }

    return val
  })
