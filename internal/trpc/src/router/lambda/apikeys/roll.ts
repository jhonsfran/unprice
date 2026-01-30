import { TRPCError } from "@trpc/server"
import { selectApiKeySchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

import { FEATURE_SLUGS } from "@unprice/config"
import { ApiKeysService } from "@unprice/services/apikey"
import { featureGuard } from "#utils/feature-guard"

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
    const project = opts.ctx.project
    const featureSlug = FEATURE_SLUGS.API_KEYS.SLUG

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const result = await featureGuard({
      customerId: project.workspace.unPriceCustomerId,
      featureSlug,
      isMain: project.workspace.isMain,
      metadata: {
        action: "roll",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const apikeyService = new ApiKeysService({
      cache: opts.ctx.cache,
      metrics: opts.ctx.metrics,
      analytics: opts.ctx.analytics,
      logger: opts.ctx.logger,
      db: opts.ctx.db,
      waitUntil: opts.ctx.waitUntil,
      hashCache: opts.ctx.hashCache,
    })

    const { val: newApiKey, err: newApiKeyErr } = await apikeyService.rollApiKey({
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
