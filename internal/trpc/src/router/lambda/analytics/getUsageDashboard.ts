import { analyticsIntervalSchema } from "@unprice/analytics"
import {
  emptyUsageDashboardOutput,
  getUsageDashboardOutputSchema,
  getUsageDashboard as getUsageDashboardUseCase,
  hasUsageDashboardEvidence,
} from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getUsageDashboard = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string().optional(),
      range: analyticsIntervalSchema,
      topConsumersLimit: z.number().int().min(1).max(20).optional().default(10),
    })
  )
  .output(getUsageDashboardOutputSchema)
  .query(async (opts) => {
    const projectId = opts.ctx.project.id
    const customerId = opts.input.customerId
    const range = opts.input.range
    const topConsumersLimit = opts.input.topConsumersLimit
    const cacheKey = [
      "usage-dashboard",
      projectId,
      customerId ?? "all",
      range,
      topConsumersLimit,
    ].join(":")

    const { err, val: cached } = await opts.ctx.cache.getUsageDashboard.swr(cacheKey, async () => {
      const result = await getUsageDashboardUseCase(
        {
          analytics: opts.ctx.analytics,
          db: opts.ctx.db,
        },
        {
          projectId,
          ...(customerId ? { customerId } : {}),
          range,
          topConsumersLimit,
        }
      )

      if (result.err) {
        throw result.err
      }

      return hasUsageDashboardEvidence(result.val) ? result.val : undefined
    })

    if (err) {
      opts.ctx.logger.error(err, {
        context: "getUsageDashboard failed",
        project_id: projectId,
        ...(customerId ? { customer_id: customerId } : {}),
        range,
      })

      return emptyUsageDashboardOutput(
        range,
        err instanceof Error ? err.message : "Failed to fetch usage dashboard"
      )
    }

    // Remove empty entries written by older code. New empty reads return
    // undefined from the loader, so the cache keeps treating them as misses.
    if (cached && !hasUsageDashboardEvidence(cached)) {
      await opts.ctx.cache.getUsageDashboard.remove(cacheKey)
    }

    return cached ?? emptyUsageDashboardOutput(range)
  })
