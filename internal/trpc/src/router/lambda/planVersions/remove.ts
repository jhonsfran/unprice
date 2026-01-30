import { TRPCError } from "@trpc/server"
import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { planVersionSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"

import { FEATURE_SLUGS } from "@unprice/config"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const remove = protectedProjectProcedure
  .input(
    planVersionSelectBaseSchema
      .pick({
        id: true,
      })
      .required({ id: true })
  )
  .output(z.object({ planVersion: planVersionSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const workspace = opts.ctx.project.workspace

    // only owner and admin can delete a plan version
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    // check if the customer has access to the feature
    const result = await featureGuard({
      customerId: workspace.unPriceCustomerId,
      featureSlug: FEATURE_SLUGS.PLANS.SLUG,
      isMain: workspace.isMain,
      metadata: {
        action: "remove",
        module: "planVersion",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const planVersionData = await opts.ctx.db.query.versions.findFirst({
      where: (version, { and, eq }) => and(eq(version.id, id), eq(version.projectId, project.id)),
    })

    if (!planVersionData?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "version not found",
      })
    }

    // TODO: should we allow to delete a published version when there is no subscription?
    if (planVersionData?.status === "published") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Cannot delete a published version, deactivate it instead",
      })
    }

    const deletedPlanVersion = await opts.ctx.db
      .delete(schema.versions)
      .where(
        and(eq(schema.versions.projectId, project.id), eq(schema.versions.id, planVersionData.id))
      )
      .returning()
      .then((data) => data[0])

    if (!deletedPlanVersion?.id) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting version",
      })
    }

    // avoid reporting usage for flat features
    if (result.featureType !== "flat") {
      opts.ctx.waitUntil(
        reportUsageFeature({
          customerId: workspace.unPriceCustomerId,
          featureSlug: "plans",
          usage: -1,
          isMain: workspace.isMain,
          metadata: {
            action: "remove",
            module: "planVersion",
          },
        })
      )
    }

    return {
      planVersion: deletedPlanVersion,
    }
  })
