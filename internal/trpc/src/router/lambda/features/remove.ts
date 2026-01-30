import { TRPCError } from "@trpc/server"
import { FEATURE_SLUGS } from "@unprice/config"
import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { featureSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const remove = protectedProjectProcedure
  .input(featureSelectBaseSchema.pick({ id: true }))
  .output(z.object({ feature: featureSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project

    const result = await featureGuard({
      customerId: project.workspace.unPriceCustomerId,
      featureSlug: FEATURE_SLUGS.PLANS.SLUG,
      metadata: {
        action: "remove",
        module: "feature",
      },
      isMain: project.workspace.isMain,
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const deletedFeature = await opts.ctx.db
      .delete(schema.features)
      .where(and(eq(schema.features.projectId, project.id), eq(schema.features.id, id)))
      .returning()
      .then((data) => data[0])

    if (!deletedFeature) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting feature",
      })
    }

    // avoid reporting usage for flat features
    if (result.featureType !== "flat") {
      opts.ctx.waitUntil(
        reportUsageFeature({
          customerId: project.workspace.unPriceCustomerId,
          featureSlug: FEATURE_SLUGS.PLANS.SLUG,
          usage: -1,
          isMain: project.workspace.isMain,
          metadata: {
            action: "remove",
            module: "feature",
          },
        })
      )
    }

    return {
      feature: deletedFeature,
    }
  })
