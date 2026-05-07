import { TRPCError } from "@trpc/server"
import {
  insertPaymentProviderConfigSchema,
  selectPaymentProviderConfigSchema,
} from "@unprice/db/validators"
import { savePaymentProviderConfig as savePaymentProviderConfigUseCase } from "@unprice/services/use-cases"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

const saveConfigInputSchema = insertPaymentProviderConfigSchema.extend({
  key: z.string().min(1),
})

export const saveConfig = protectedProjectProcedure
  .input(saveConfigInputSchema)
  .output(z.object({ paymentProviderConfig: selectPaymentProviderConfigSchema }))
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { key, paymentProvider, webhookSecret } = opts.input
    const projectId = opts.ctx.project.id

    const { val, err } = await savePaymentProviderConfigUseCase(
      {
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        projectId,
        key,
        webhookSecret: webhookSecret ?? undefined,
        paymentProvider,
      }
    )

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return { paymentProviderConfig: val }
  })
