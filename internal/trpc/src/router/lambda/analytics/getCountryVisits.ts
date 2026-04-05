import type { Analytics } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export type PageCountryVisits = Awaited<ReturnType<Analytics["getCountryVisits"]>>["data"]

export const getCountryVisits = protectedProjectProcedure
  .input(z.custom<Parameters<Analytics["getCountryVisits"]>[0]>())
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
      return { data: [], error: err.message }
    }

    return val
  })
