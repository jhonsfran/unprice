import type { Analytics } from "@unprice/analytics"
import { z } from "zod"
import { protectedProcedure } from "#trpc"
import { TIMEOUTS, withTimeout } from "#utils/timeout"

const getPlanClickBySessionIdInputSchema = z.object({
  session_id: z.string(),
  action: z.literal("plan_click"),
  interval_days: z.number().optional(),
})

export const getPlanClickBySessionId = protectedProcedure
  .input(getPlanClickBySessionIdInputSchema)
  .output(
    z.object({
      planClick: z.custom<Awaited<ReturnType<Analytics["getPlanClickBySessionId"]>>["data"]>(),
    })
  )
  .query(async (opts) => {
    const input = opts.input

    try {
      const { err: projectErr, val: mainProject } =
        await opts.ctx.services.projects.getMainProjectBySlug({
          slug: "unprice-admin",
        })

      if (projectErr || !mainProject?.id) {
        opts.ctx.logger.error(projectErr ?? new Error("Main project not found"), {
          context: "getPlanClickBySessionId main project lookup failed",
        })

        return { planClick: [] }
      }

      const result = await withTimeout(
        opts.ctx.analytics.getPlanClickBySessionId({
          session_id: input.session_id,
          project_id: mainProject.id,
          action: input.action,
          interval_days: input.interval_days,
        }),
        TIMEOUTS.ANALYTICS,
        "getPlanClickBySessionId analytics request timeout"
      )

      return { planClick: result.data }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error"

      opts.ctx.logger.error(err, {
        context: "getPlanClickBySessionId failed",
        isTimeout: errorMessage.includes("timeout"),
      })

      // Return empty data as fallback
      return { planClick: [] }
    }
  })
