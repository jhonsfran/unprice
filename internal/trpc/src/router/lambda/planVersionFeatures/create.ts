import { TRPCError } from "@trpc/server"
import * as schema from "@unprice/db/schema"
import * as utils from "@unprice/db/utils"
import {
  planVersionFeatureDragDropSchema,
  planVersionFeatureInsertBaseSchema,
} from "@unprice/db/validators"
import { z } from "zod"

import { FEATURE_SLUGS } from "@unprice/config"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const create = protectedProjectProcedure
  .input(planVersionFeatureInsertBaseSchema)
  .output(
    z.object({
      planVersionFeature: planVersionFeatureDragDropSchema,
    })
  )
  .mutation(async (opts) => {
    const {
      featureId,
      planVersionId,
      featureType,
      config,
      metadata,
      order,
      defaultQuantity,
      limit,
      billingConfig,
      resetConfig,
      type,
      aggregationMethod,
    } = opts.input
    const project = opts.ctx.project

    const workspace = project.workspace
    const customerId = workspace.unPriceCustomerId
    const featureSlug = FEATURE_SLUGS.PLAN_VERSIONS.SLUG

    // only owner and admin can create a feature
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const result = await featureGuard({
      customerId,
      featureSlug,
      isMain: workspace.isMain,
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

    const planVersionData = await opts.ctx.db.query.versions.findFirst({
      where: (version, { eq, and }) =>
        and(eq(version.id, planVersionId), eq(version.projectId, project.id)),
    })

    if (!planVersionData?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "version of the plan not found",
      })
    }

    // if published we should not allow to add a feature
    if (planVersionData.status === "published") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Cannot add a feature to a published version",
      })
    }

    const featureData = await opts.ctx.db.query.features.findFirst({
      where: (feature, { eq, and }) =>
        and(eq(feature.id, featureId), eq(feature.projectId, project.id)),
    })

    if (!featureData?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "feature not found",
      })
    }

    const planVersionFeatureId = utils.newId("feature_version")

    // only usage items can have a different billing config but the billing anchor should be the same as the plan version billing config
    const billingConfigCreate =
      featureType === "usage" ? billingConfig : planVersionData.billingConfig

    const planVersionFeatureCreated = await opts.ctx.db
      .insert(schema.planVersionFeatures)
      .values({
        id: planVersionFeatureId,
        featureId: featureData.id,
        projectId: project.id,
        planVersionId: planVersionData.id,
        // for now we use the same billing config as the plan version
        billingConfig: {
          ...billingConfigCreate,
          billingAnchor: planVersionData.billingConfig.billingAnchor,
        },
        featureType,
        config: config!,
        metadata,
        order: order ?? "1024",
        defaultQuantity: defaultQuantity === 0 ? null : defaultQuantity,
        limit: limit === 0 ? null : limit,
        resetConfig,
        type,
        // flat features don't have a meter so we don't need to store the aggregation method
        aggregationMethod: featureType !== "usage" ? "none" : aggregationMethod,
      })
      .returning()
      .then((re) => re[0])

    if (!planVersionFeatureCreated?.id) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error creating feature for this version",
      })
    }

    const planVersionFeatureData = await opts.ctx.db.query.planVersionFeatures.findFirst({
      with: {
        planVersion: true,
        feature: true,
      },
      where: (planVersionFeature, { and, eq }) =>
        and(
          eq(planVersionFeature.id, planVersionFeatureCreated.id),
          eq(planVersionFeature.projectId, project.id)
        ),
    })

    if (!planVersionFeatureData?.id) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error fetching the created feature",
      })
    }

    // avoid reporting usage for flat features
    if (result.featureType !== "flat") {
      opts.ctx.waitUntil(
        reportUsageFeature({
          customerId,
          featureSlug,
          usage: 1,
          isMain: workspace.isMain,
          metadata: {
            action: "create",
          },
        })
      )
    }

    return {
      planVersionFeature: planVersionFeatureData,
    }
  })
