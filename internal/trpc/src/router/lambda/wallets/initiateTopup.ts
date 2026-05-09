import { TRPCError } from "@trpc/server"
import { currencySchema, paymentProviderSchema } from "@unprice/db/validators"
import { initiateTopup as initiateTopupUseCase } from "@unprice/services/use-cases"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

export const initiateTopup = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
      provider: paymentProviderSchema,
      amount: z
        .number()
        .int()
        .positive()
        .describe("Top-up amount in pgledger scale-8 minor units ($1 = 100_000_000)"),
      currency: currencySchema,
      successUrl: z.string().url(),
      cancelUrl: z.string().url(),
      description: z.string().optional(),
    })
  )
  .output(
    z.object({
      topupId: z.string(),
      checkoutUrl: z.string(),
      providerSessionId: z.string(),
    })
  )
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const { project } = opts.ctx

    const { val, err } = await initiateTopupUseCase(
      {
        services: { customers: opts.ctx.services.customers },
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        projectId: project.id,
        customerId: opts.input.customerId,
        provider: opts.input.provider,
        amount: opts.input.amount,
        currency: opts.input.currency,
        successUrl: opts.input.successUrl,
        cancelUrl: opts.input.cancelUrl,
        description: opts.input.description,
      }
    )

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return val
  })
