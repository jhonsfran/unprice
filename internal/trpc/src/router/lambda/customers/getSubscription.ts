import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

type CustomerSubscriptionResult = Awaited<
  ReturnType<typeof unprice.customers.getSubscription>
>["result"]

export const getSubscription = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(
    z.object({
      subscription: z.custom<CustomerSubscriptionResult | null>(),
    })
  )
  .query(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx

    const { result, error } = await unprice.customers.getSubscription({
      customerId,
      projectId: project.id,
    })

    if (error) {
      opts.ctx.logger.error(error)
    }

    return {
      subscription: result ?? null,
    }
  })
