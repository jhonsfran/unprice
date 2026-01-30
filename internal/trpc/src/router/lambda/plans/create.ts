import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { FEATURE_SLUGS } from "@unprice/config"
import * as schema from "@unprice/db/schema"
import * as utils from "@unprice/db/utils"
import { planInsertBaseSchema, planSelectBaseSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const create = protectedProjectProcedure
  .input(planInsertBaseSchema)
  .output(
    z.object({
      plan: planSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const { slug, description, defaultPlan, enterprisePlan } = opts.input
    const project = opts.ctx.project
    const workspace = opts.ctx.project.workspace
    const customerId = workspace.unPriceCustomerId
    const featureSlug = FEATURE_SLUGS.PLANS.SLUG

    // only owner and admin can create a plan
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    // check if the customer has access to the feature
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

    const planId = utils.newId("plan")

    if (defaultPlan && enterprisePlan) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "A plan cannot be both a default and enterprise plan",
      })
    }

    if (defaultPlan) {
      const defaultPlanData = await opts.ctx.db.query.plans.findFirst({
        where: (plan, { eq, and }) =>
          and(eq(plan.projectId, project.id), eq(plan.defaultPlan, true)),
      })

      if (defaultPlanData?.id) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "There is already a default plan for this app",
        })
      }
    }

    if (enterprisePlan) {
      const enterprisePlanData = await opts.ctx.db.query.plans.findFirst({
        where: (plan, { eq, and }) =>
          and(eq(plan.projectId, project.id), eq(plan.enterprisePlan, true)),
      })

      if (enterprisePlanData?.id) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "There is already an enterprise plan for this app, create a new version instead",
        })
      }
    }

    const planData = await opts.ctx.db
      .insert(schema.plans)
      .values({
        id: planId,
        slug,
        projectId: project.id,
        description,
        active: true,
        defaultPlan: defaultPlan ?? false,
        enterprisePlan: enterprisePlan ?? false,
      })
      .returning()
      .then((planData) => {
        return planData[0]
      })

    if (!planData?.id) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "error creating plan",
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
      plan: planData,
    }
  })
