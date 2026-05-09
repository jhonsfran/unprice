import { TRPCError } from "@trpc/server"
import { paymentProviderSchema, selectPaymentProviderConfigSchema } from "@unprice/db/validators"
import { getProviderConnection } from "@unprice/services/use-cases"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

export const getConnection = protectedProjectProcedure
  .input(z.object({ paymentProvider: paymentProviderSchema }))
  .output(z.object({ paymentProviderConfig: selectPaymentProviderConfigSchema.optional() }))
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN", "MEMBER"])

    const { err, val } = await getProviderConnection(
      {
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        projectId: opts.ctx.project.id,
        paymentProvider: opts.input.paymentProvider,
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
