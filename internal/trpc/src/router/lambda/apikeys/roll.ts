import { TRPCError } from "@trpc/server"
import { selectApiKeySchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const roll = protectedProjectProcedure
  .input(z.object({ hashKey: z.string() }))
  .output(
    z.object({
      apikey: selectApiKeySchema.extend({
        key: z.string(),
      }),
    })
  )
  .mutation(async (opts) => {
    const { hashKey } = opts.input
    const _project = opts.ctx.project
    const { apikeys } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val: newApiKey, err: newApiKeyErr } = await apikeys.rollApiKey({
      keyHash: hashKey,
    })

    if (newApiKeyErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: newApiKeyErr.message,
      })
    }

    return { apikey: { ...newApiKey, key: newApiKey.newKey } }
  })
