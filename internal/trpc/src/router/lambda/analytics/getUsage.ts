import { type Usage, analyticsIntervalSchema } from "@unprice/analytics"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

export const getUsage = protectedWorkspaceProcedure
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
    const customerId = opts.input.customerId || opts.ctx.workspace.unPriceCustomerId
    const range = opts.input.range

    if (!customerId) {
      return {
        usage: [],
        error: "Customer ID is required",
      }
    }

    const { result, error } = await unprice.analytics.usage.get({
      customer_id: customerId,
      range,
    })

    if (error || !result) {
      opts.ctx.logger.error(error?.message ?? "Failed to fetch analytics usage from SDK", {
        customer_id: customerId,
        range,
      })
      return {
        usage: [],
        error: error?.message ?? "Failed to fetch usage",
      }
    }

    return { usage: result.usage ?? [] }
  })
