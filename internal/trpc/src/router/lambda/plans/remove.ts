import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { FEATURE_SLUGS } from "@unprice/config"
import { and, eq, sql } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { planSelectBaseSchema } from "@unprice/db/validators"

import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const remove = protectedProjectProcedure
  .input(planSelectBaseSchema.pick({ id: true }))
  .output(z.object({ plan: planSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const workspace = opts.ctx.project.workspace
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const result = await featureGuard({
      customerId: workspace.unPriceCustomerId,
      featureSlug: FEATURE_SLUGS.PLANS.SLUG,
      isMain: workspace.isMain,
      metadata: {
        action: "remove",
        module: "plan",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const countVersionsPlan = await opts.ctx.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.versions)
      .where(
        and(
          eq(schema.versions.projectId, project.id),
          eq(schema.versions.planId, id),
          eq(schema.versions.status, "published")
        )
      )
      .then((res) => res[0]?.count ?? 0)

    if (countVersionsPlan > 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "You cannot delete a plan that has published versions. Please deactivate it instead",
      })
    }

    const deletedPlan = await opts.ctx.db
      .delete(schema.plans)
      .where(and(eq(schema.plans.projectId, project.id), eq(schema.plans.id, id)))
      .returning()
      .then((data) => data[0])

    if (!deletedPlan) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting plan",
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
            module: "plan",
          },
        })
      )
    }

    return {
      plan: deletedPlan,
    }
  })
