import { TRPCError } from "@trpc/server"
import { paymentProviderSchema, selectPaymentProviderConfigSchema } from "@unprice/db/validators"
import { setProviderEnabled } from "@unprice/services/use-cases"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

const setEnabledInputSchema = z.object({
  paymentProvider: paymentProviderSchema,
  enabled: z.boolean(),
})

export const setEnabled = protectedProjectProcedure
  .input(setEnabledInputSchema)
  .output(z.object({ paymentProviderConfig: selectPaymentProviderConfigSchema.optional() }))
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await setProviderEnabled(
      {
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        projectId: opts.ctx.project.id,
        paymentProvider: opts.input.paymentProvider,
        enabled: opts.input.enabled,
      }
    )

    if (err) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: err.message,
      })
    }

    return val
  })
