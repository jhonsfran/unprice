import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

type CustomerUsageResult = Awaited<ReturnType<typeof unprice.customers.getUsage>>["result"]

export const getUsage = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(
    z.object({
      usage: z.custom<CustomerUsageResult | null>(),
    })
  )
  .query(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx

    const { result, error } = await unprice.customers.getUsage({
      customerId,
      projectId: project.id,
    })

    if (error) {
      opts.ctx.logger.error(error)
    }
    return {
      usage: result ?? null,
    }
  })
