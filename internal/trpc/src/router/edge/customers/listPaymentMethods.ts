import { customerPaymentMethodSchema, paymentProviderSchema } from "@unprice/db/validators"
import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { protectedWorkspaceProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

export const listPaymentMethods = protectedWorkspaceProcedure
  .input(
    z.object({
      customerId: z.string(),
      provider: paymentProviderSchema,
      skipCache: z.boolean().optional(),
    })
  )
  .output(
    z.object({
      paymentMethods: customerPaymentMethodSchema.array(),
    })
  )
  .query(async (opts) => {
    const { customerId: inputCustomerId, provider, skipCache } = opts.input
    const customerId = opts.ctx.workspace.unPriceCustomerId

    if (!customerId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Workspace billing customer not found",
      })
    }

    if (inputCustomerId !== customerId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Customer does not belong to the active workspace",
      })
    }

    const result = await unprice.paymentMethods.list({
      customerId,
      provider,
      skipCache,
    })

    if (result.error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.error.message,
      })
    }

    return {
      paymentMethods: result.result,
    }
  })
