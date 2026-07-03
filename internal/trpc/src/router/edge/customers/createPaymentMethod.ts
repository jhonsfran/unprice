import { TRPCError } from "@trpc/server"
import {
  createPaymentMethodResponseSchema,
  createPaymentMethodSchema,
} from "@unprice/db/validators"
import { protectedWorkspaceRateLimitedProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

export const createPaymentMethod = protectedWorkspaceRateLimitedProcedure({
  limit: 30,
  name: "edge.customers.createPaymentMethod",
  scope: "workspace",
  windowSeconds: 10 * 60,
})
  .input(createPaymentMethodSchema)
  .output(createPaymentMethodResponseSchema)
  .mutation(async (opts) => {
    const { successUrl, cancelUrl, customerId: inputCustomerId, paymentProvider } = opts.input
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

    const response = await unprice.paymentMethods.create({
      successUrl,
      cancelUrl,
      customerId,
      paymentProvider,
    })

    if (response.error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: response.error.message,
      })
    }

    return response.result
  })
