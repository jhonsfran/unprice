import { TRPCError } from "@trpc/server"
import { FEATURE_SLUGS } from "@unprice/config"
import * as schema from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import { featureInsertBaseSchema, featureSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const create = protectedProjectProcedure
  .input(featureInsertBaseSchema)
  .output(z.object({ feature: featureSelectBaseSchema }))
  .mutation(async (opts) => {
    const { description, slug, title, unit } = opts.input
    const project = opts.ctx.project

    // check if the customer has access to the feature
    const result = await featureGuard({
      customerId: project.workspace.unPriceCustomerId,
      featureSlug: FEATURE_SLUGS.PLANS.SLUG,
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

    const featureId = newId("feature")
    const featureData = await opts.ctx.db
      .insert(schema.features)
      .values({
        id: featureId,
        slug,
        title,
        projectId: project.id,
        description,
        unit,
      })
      .returning()
      .then((data) => data[0])

    if (!featureData) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error creating feature",
      })
    }

    opts.ctx.waitUntil(
      Promise.all([
        result.featureType !== "flat" &&
          reportUsageFeature({
            customerId: project.workspace.unPriceCustomerId,
            featureSlug: "plans",
            usage: 1,
            isMain: project.workspace.isMain,
            metadata: {
              action: "create",
              module: "feature",
            },
          }),
        opts.ctx.analytics.ingestFeatures({
          id: featureId,
          project_id: project.id,
          slug,
          code: featureData.code,
          timestamp: new Date().toISOString(),
        }),
      ])
    )

    return {
      feature: featureData,
    }
  })
