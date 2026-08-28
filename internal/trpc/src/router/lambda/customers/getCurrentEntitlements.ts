import { TRPCError } from "@trpc/server"
import { getCustomerCurrentEntitlementsOutputSchema } from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

export const getCurrentEntitlements = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(getCustomerCurrentEntitlementsOutputSchema)
  .query(async (opts) => {
    const { result, error } = await unprice.access.entitlements.current({
      customerId: opts.input.customerId,
      projectId: opts.ctx.project.id,
    })

    if (error) {
      opts.ctx.logger.error(new Error(error.message), {
        customer_id: opts.input.customerId,
        project_id: opts.ctx.project.id,
      })
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: error.message,
      })
    }

    return result
  })
