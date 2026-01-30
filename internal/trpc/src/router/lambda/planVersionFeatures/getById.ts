import { TRPCError } from "@trpc/server"
import { z } from "zod"

import {
  featureSelectBaseSchema,
  planVersionFeatureSelectBaseSchema,
  planVersionSelectBaseSchema,
} from "@unprice/db/validators"

import { FEATURE_SLUGS } from "@unprice/config"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

export const getById = protectedProjectProcedure
  .input(
    z.object({
      id: z.string(),
    })
  )
  .output(
    z.object({
      planVersionFeature: planVersionFeatureSelectBaseSchema.extend({
        planVersion: planVersionSelectBaseSchema,
        feature: featureSelectBaseSchema,
      }),
    })
  )
  .query(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project

    const workspace = project.workspace
    const customerId = workspace.unPriceCustomerId
    const featureSlug = FEATURE_SLUGS.PLAN_VERSIONS.SLUG

    const result = await featureGuard({
      customerId,
      featureSlug,
      isMain: workspace.isMain,
      metadata: {
        action: "getById",
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
        feature: true,
      },
      where: (planVersion, { and, eq }) =>
        and(eq(planVersion.id, id), eq(planVersion.projectId, project.id)),
    })

    if (!planVersionFeatureData) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Plan version feature not found",
      })
    }

    return {
      planVersionFeature: planVersionFeatureData,
    }
  })
