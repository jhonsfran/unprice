import { TRPCError } from "@trpc/server"
import {
  createPaymentMethodResponseSchema,
  createPaymentMethodSchema,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectRateLimitedProcedure } from "#trpc"

export const createPaymentMethodByActiveProject = protectedProjectRateLimitedProcedure({
  limit: 30,
  name: "customers.createPaymentMethodByActiveProject",
  scope: "project",
  windowSeconds: 10 * 60,
})
  .input(
    createPaymentMethodSchema.extend({
      projectSlug: z.string().optional(),
    })
  )
  .output(createPaymentMethodResponseSchema)
  .mutation(async (opts) => {
    const { successUrl, cancelUrl, customerId, paymentProvider } = opts.input
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

    const { err: providerErr, val: paymentProviderService } = await customers.getPaymentProvider({
      customerId,
      projectId: project.id,
      provider: paymentProvider,
    })

    if (providerErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: providerErr.message,
      })
    }

    const { err, val } = await paymentProviderService.createSession({
      customerId,
      projectId: project.id,
      email: customer.email,
      currency: customer.defaultCurrency,
      successUrl,
      cancelUrl,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return val
  })
