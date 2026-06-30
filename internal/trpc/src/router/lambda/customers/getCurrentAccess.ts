import { TRPCError } from "@trpc/server"
import {
  getCustomerCurrentAccess,
  getCustomerCurrentAccessOutputSchema,
} from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getCurrentAccess = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(getCustomerCurrentAccessOutputSchema)
  .query(async (opts) => {
    const result = await getCustomerCurrentAccess(
      {
        db: opts.ctx.db,
        analytics: opts.ctx.analytics,
        logger: opts.ctx.logger,
      },
      {
        projectId: opts.ctx.project.id,
        customerId: opts.input.customerId,
      }
    )

    if (result.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    if (!result.val) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    return result.val
  })
