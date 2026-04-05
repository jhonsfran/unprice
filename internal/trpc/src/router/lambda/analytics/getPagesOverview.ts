import type { Analytics } from "@unprice/analytics"
import type { PageOverview } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getPagesOverview = protectedProjectProcedure
  .input(z.custom<Parameters<Analytics["getPagesOverview"]>[0]>())
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
