import { TRPCError } from "@trpc/server"
import { customerPaymentMethodSchema, paymentProviderSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const listPaymentMethodsByActiveProject = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
      provider: paymentProviderSchema,
      projectSlug: z.string().optional(),
      skipCache: z.boolean().optional(),
    })
  )
  .output(
    z.object({
      paymentMethods: customerPaymentMethodSchema.array(),
    })
  )
  .query(async (opts) => {
    const { customerId, provider, skipCache } = opts.input
    const { project } = opts.ctx
    const { customers } = opts.ctx.services

    const { err: customerErr, val: customer } = await customers.getCustomerByIdInProject({
      id: customerId,
      projectId: project.id,
    })

    if (customerErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: customerErr.message,
      })
    }

    if (!customer) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    const { err, val } = await customers.getPaymentMethods({
      customerId,
      provider,
      projectId: project.id,
      opts: {
        skipCache,
      },
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      paymentMethods: val,
    }
  })
