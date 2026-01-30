import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { planVersionFeatureSelectBaseSchema } from "@unprice/db/validators"

import { FEATURE_SLUGS } from "@unprice/config"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const remove = protectedProjectProcedure
  .input(
    planVersionFeatureSelectBaseSchema
      .pick({
        id: true,
      })
      .required({ id: true })
  )
  .output(z.object({ plan: planVersionFeatureSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const workspace = project.workspace
    const customerId = workspace.unPriceCustomerId
    const featureSlug = FEATURE_SLUGS.PLAN_VERSIONS.SLUG

    // only owner and admin can delete a feature
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    // check if the customer has access to the feature
    const result = await featureGuard({
      customerId,
      featureSlug,
      isMain: workspace.isMain,
      metadata: {
        action: "remove",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const planVersionFeatureData = await opts.ctx.db.query.planVersionFeatures.findFirst({
      with: {
        planVersion: true,
      },
      where: (featureVersion, { and, eq }) =>
        and(eq(featureVersion.id, id), eq(featureVersion.projectId, project.id)),
    })

    if (!planVersionFeatureData?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "feature version not found",
      })
    }

    if (planVersionFeatureData.planVersion.status === "published") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Cannot delete a feature from a published version",
      })
    }

    const deletedPlanVersion = await opts.ctx.db
      .delete(schema.planVersionFeatures)
      .where(
        and(
          eq(schema.planVersionFeatures.projectId, project.id),
          eq(schema.planVersionFeatures.id, planVersionFeatureData.id)
        )
      )
      .returning()
      .then((data) => data[0])

    if (!deletedPlanVersion?.id) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting feature",
      })
    }

    // avoid reporting usage for flat features
    if (result.featureType !== "flat") {
      opts.ctx.waitUntil(
        reportUsageFeature({
          customerId,
          featureSlug,
          usage: -1,
          isMain: workspace.isMain,
          metadata: {
            action: "remove",
          },
        })
      )
    }

    return {
      plan: deletedPlanVersion,
    }
  })
