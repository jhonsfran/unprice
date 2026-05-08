import { TRPCError } from "@trpc/server"
import {
  createPaymentMethodResponseSchema,
  createPaymentMethodSchema,
} from "@unprice/db/validators"
import { protectedWorkspaceProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

export const createPaymentMethod = protectedWorkspaceProcedure
  .input(createPaymentMethodSchema)
  .output(createPaymentMethodResponseSchema)
  .mutation(async (opts) => {
    const { successUrl, cancelUrl, customerId, paymentProvider } = opts.input

    const response = await unprice.payments.methods.create({
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
