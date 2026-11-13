import { analyticsIntervalSchema } from "@unprice/db/validators"
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
          budgetJournal: opts.ctx.services.budgetJournal,
          customers: opts.ctx.services.customers,
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

    return cached ?? emptyUsageDashboardOutput(range)
  })
