import { TRPCError } from "@trpc/server"
import { paymentProviderSchema, selectPaymentProviderConfigSchema } from "@unprice/db/validators"
import { refreshProviderConnection } from "@unprice/services/use-cases"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

const connectionLinkInputSchema = z.object({
  paymentProvider: paymentProviderSchema,
  returnUrl: z.string().url(),
  refreshUrl: z.string().url(),
})

export const refreshConnection = protectedProjectProcedure
  .input(connectionLinkInputSchema)
  .output(
    z.object({ url: z.string().url(), paymentProviderConfig: selectPaymentProviderConfigSchema })
  )
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await refreshProviderConnection(
      {
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        projectId: opts.ctx.project.id,
        paymentProvider: opts.input.paymentProvider,
        returnUrl: opts.input.returnUrl,
        refreshUrl: opts.input.refreshUrl,
        ownerEmail: opts.ctx.session.user.email,
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
