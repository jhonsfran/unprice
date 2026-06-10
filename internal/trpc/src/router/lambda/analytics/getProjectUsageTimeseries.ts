import {
  type FeatureUsageTimeseriesRow,
  analyticsIntervalSchema,
  prepareInterval,
} from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { TIMEOUTS, withTimeout } from "#utils/timeout"

export const getProjectUsageTimeseries = protectedProjectProcedure
  .input(
    z.object({
      range: analyticsIntervalSchema,
    })
  )
  .output(
    z.object({
      timeseries: z.custom<FeatureUsageTimeseriesRow[]>(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const range = opts.input.range
    const projectId = opts.ctx.project.id
    const { start, end } = prepareInterval(range)
    const cacheKey = `${projectId}:${range}`

    const { err, val: cached } = await opts.ctx.cache.getUsageTimeseries.swr(cacheKey, async () => {
      const data = await withTimeout(
        opts.ctx.analytics.getFeaturesUsageTimeseries({
          project_id: projectId,
          start,
          end,
        }),
        TIMEOUTS.ANALYTICS,
        "getProjectUsageTimeseries analytics request timeout"
      )

      return data.data ?? []
    })

    if (err) {
      opts.ctx.logger.error(err, {
        context: "getProjectUsageTimeseries failed",
        project_id: projectId,
        range,
      })

      return {
        timeseries: [],
        error: err instanceof Error ? err.message : "Failed to fetch usage timeseries",
      }
    }

    return { timeseries: cached ?? [] }
  })
