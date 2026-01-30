import { TRPCError } from "@trpc/server"
import { FEATURE_SLUGS } from "@unprice/config"
import { apikeys } from "@unprice/db/schema"
import { hashStringSHA256, newId } from "@unprice/db/utils"
import { createApiKeySchema, selectApiKeySchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const create = protectedProjectProcedure
  .input(createApiKeySchema)
  .output(
    z.object({
      apikey: selectApiKeySchema.extend({
        key: z.string(),
      }),
    })
  )
  .mutation(async (opts) => {
    const { name, expiresAt } = opts.input
    const project = opts.ctx.project
    const customerId = project.workspace.unPriceCustomerId
    const featureSlug = FEATURE_SLUGS.API_KEYS.SLUG
    const isRoot = project.workspace.isMain

    // only owner and admin
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    // check if the customer has access to the feature
    const result = await featureGuard({
      customerId,
      featureSlug,
      isMain: project.workspace.isMain,
      metadata: {
        action: "create",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    // Generate the key
    const apiKey = newId("apikey_key")
    // generate the id
    const apiKeyId = newId("apikey")
    // generate hash of the key
    const apiKeyHash = await hashStringSHA256(apiKey)

    const newApiKey = await opts.ctx.db
      .insert(apikeys)
      .values({
        id: apiKeyId,
        name: name,
        hash: apiKeyHash,
        expiresAt: expiresAt,
        projectId: project.id,
        isRoot,
      })
      .returning()
      .then((res) => res[0])
      .catch((err) => {
        opts.ctx.logger.error(err)

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create API key",
        })
      })

    if (!newApiKey) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to create API key",
      })
    }

    // avoid reporting usage for flat features
    if (result.featureType !== "flat") {
      opts.ctx.waitUntil(
        reportUsageFeature({
          customerId,
          featureSlug,
          usage: 1,
          isMain: project.workspace.isMain,
          metadata: {
            action: "create",
          },
        })
      )
    }

    return { apikey: { ...newApiKey, key: apiKey } }
  })
