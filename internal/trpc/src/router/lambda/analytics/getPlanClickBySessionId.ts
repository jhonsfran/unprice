import { attributionIdSchema } from "@unprice/db/validators"
import { planClickSchema } from "@unprice/services/analytics"
import { z } from "zod"
import { protectedProcedure } from "#trpc"
import { intervalDaysSchema } from "./web-analytics-input"

const getPlanClickBySessionIdInputSchema = z.object({
  session_id: attributionIdSchema,
  interval_days: intervalDaysSchema,
})

/** The session's latest plan click on Unprice's own pricing page, or null. */
export const getPlanClickBySessionId = protectedProcedure
  .input(getPlanClickBySessionIdInputSchema)
  .output(z.object({ planClick: planClickSchema.nullable() }))
  .query(async (opts) => {
    const input = opts.input

    const { err: projectErr, val: mainProject } =
      await opts.ctx.services.projects.getMainProjectBySlug({
        slug: "unprice-admin",
      })

    if (projectErr || !mainProject?.id) {
      opts.ctx.logger.error(projectErr ?? new Error("Main project not found"), {
        context: "getPlanClickBySessionId main project lookup failed",
      })

      return { planClick: null }
    }

    const { err, val } = await opts.ctx.services.analytics.getPlanClickBySessionId({
      projectId: mainProject.id,
      sessionId: input.session_id,
      intervalDays: input.interval_days,
    })

    if (err) {
      return { planClick: null }
    }

    return { planClick: val }
  })
