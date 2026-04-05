import { TRPCError } from "@trpc/server"
import { selectPaymentProviderConfigSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

export const getConfig = protectedProjectProcedure
  .input(selectPaymentProviderConfigSchema.pick({ paymentProvider: true }))
  .output(z.object({ paymentProviderConfig: selectPaymentProviderConfigSchema.optional() }))
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN", "MEMBER"])

    const { paymentProvider } = opts.input
    const projectId = opts.ctx.project.id
    const { projects } = opts.ctx.services

    // TODO: use this for configuration of payment providers
    // const aesGCM = await AesGCM.withBase64Key(env.ENCRYPTION_KEY)

    const { err, val: config } = await projects.getPaymentProviderConfig({
      projectId,
      paymentProvider,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!config) {
      return { paymentProviderConfig: undefined }
    }

    // const decryptedKey = await aesGCM.decrypt({
    //   iv: config.keyIv,
    //   ciphertext: config.key,
    // })

    // return
    return {
      paymentProviderConfig: config,
    }
  })
