import { type Usage, analyticsIntervalSchema } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

export const getProjectUsage = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string().optional(),
      range: analyticsIntervalSchema,
    })
  )
  .output(
    z.object({
      usage: z.custom<Usage>(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const customerId = opts.input.customerId
    const range = opts.input.range
    const projectId = opts.ctx.project.id

    const { result, error } = await unprice.analytics.usage.get({
      ...(customerId ? { customer_id: customerId } : {}),
      project_id: projectId,
      range,
    })

    if (error || !result) {
      opts.ctx.logger.error(error?.message ?? "Failed to fetch analytics project usage", {
        ...(customerId ? { customer_id: customerId } : {}),
        project_id: projectId,
        range,
      })
      return {
        usage: [],
        error: error?.message ?? "Failed to fetch usage",
      }
    }

    return { usage: result.usage ?? [] }
  })
