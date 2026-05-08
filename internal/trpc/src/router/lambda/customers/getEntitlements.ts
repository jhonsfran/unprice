import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

type CustomerEntitlementsResult = NonNullable<
  Awaited<ReturnType<typeof unprice.entitlements.get>>["result"]
>

export const getEntitlements = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(
    z.object({
      entitlements: z.custom<CustomerEntitlementsResult>(),
    })
  )
  .query(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx

    const { result, error } = await unprice.entitlements.get({
      customerId,
      projectId: project.id,
    })

    if (error) {
      opts.ctx.logger.error(error)
    }

    return {
      entitlements: result ?? [],
    }
  })
