import {
  type Analytics,
  type AnalyticsEventAction,
  schemaPageHit,
  schemaPlanClick,
  schemaSignUp,
} from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { TIMEOUTS, withTimeout } from "#utils/timeout"

export const getLatestEvents = protectedProjectProcedure
  .input(z.custom<Parameters<Analytics["getLatestEvents"]>[0]>())
  .output(
    z.object({
      data: z
        .object({
          timestamp: z.coerce.date(),
          name: z.string(),
          action: z.custom<AnalyticsEventAction>(),
          session_id: z.string(),
          description: z.string(),
        })
        .array(),
      project_id: z.string(),
    })
  )
  .query(async (opts) => {
    const { action, interval_days } = opts.input
    const project_id = opts.ctx.project.id

    try {
      const data = await withTimeout(
        opts.ctx.analytics.getLatestEvents({
          action,
          interval_days,
          project_id: project_id,
        }),
        TIMEOUTS.ANALYTICS,
        "getLatestEvents analytics request timeout"
      )

      const result = data.data.map((event) => {
        switch (event.action) {
          case "plan_click": {
            const payload = schemaPlanClick.parse(JSON.parse(event.payload))
            return {
              action: event.action as AnalyticsEventAction,
              timestamp: event.timestamp,
              session_id: event.session_id,
              name: "Plan clicked",
              description: `${payload.page_id}`,
            }
          }
          case "page_hit": {
            const payload = schemaPageHit.parse(JSON.parse(event.payload))
            return {
              action: event.action as AnalyticsEventAction,
              timestamp: event.timestamp,
              session_id: event.session_id,
              name: "Page hit",
              description: `${payload.pathname}`,
            }
          }
          case "signup": {
            const payload = schemaSignUp.parse(JSON.parse(event.payload))
            return {
              action: event.action as AnalyticsEventAction,
              timestamp: event.timestamp,
              session_id: event.session_id,
              name: "Signup",
              description: `${payload.customer_id}`,
            }
          }
          default: {
            return {
              action: event.action as AnalyticsEventAction,
              timestamp: event.timestamp,
              session_id: event.session_id,
              name: "Unknown event",
              description: `Unknown event ${event.action}`,
            }
          }
        }
      })

      return { data: result, project_id }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error"

      opts.ctx.logger.error(err, {
        context: "getLatestEvents failed",
        project_id,
        isTimeout: errorMessage.includes("timeout"),
      })

      // Return empty data as fallback
      return { data: [], project_id }
    }
  })
