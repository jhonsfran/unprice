import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { planInsertBaseSchema, planSelectBaseSchema } from "@unprice/db/validators"

import { FEATURE_SLUGS } from "@unprice/config"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

export const update = protectedProjectProcedure
  .input(planInsertBaseSchema.required({ id: true }))
  .output(
    z.object({
      plan: planSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const { id, description, active, defaultPlan, enterprisePlan } = opts.input
    const project = opts.ctx.project
    const workspace = opts.ctx.project.workspace
    const customerId = workspace.unPriceCustomerId
    const featureSlug = FEATURE_SLUGS.PLANS.SLUG

    // only owner and admin can update a plan
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const result = await featureGuard({
      customerId,
      featureSlug,
      isMain: workspace.isMain,
      metadata: {
        action: "update",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    if (defaultPlan && enterprisePlan) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "A plan cannot be both a default and enterprise plan",
      })
    }

    const planData = await opts.ctx.db.query.plans.findFirst({
      with: {
        project: {
          columns: {
            slug: true,
          },
        },
      },
      where: (plan, { eq, and }) => and(eq(plan.id, id), eq(plan.projectId, project.id)),
    })

    if (!planData?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "plan not found",
      })
    }

    if (defaultPlan) {
      const defaultPlanData = await opts.ctx.db.query.plans.findFirst({
        where: (plan, { eq, and }) =>
          and(eq(plan.projectId, project.id), eq(plan.defaultPlan, true)),
      })

      if (defaultPlanData && defaultPlanData.id !== id) {
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

      if (enterprisePlanData && enterprisePlanData.id !== id) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "There is already an enterprise plan for this app, create a new version instead",
        })
      }
    }

    // TODO: is it a good idea to let the user update the plan?
    // maybe we should think what happen if the user update the plan and there are versions
    // that are not compatible with the new plan. This is also a good reason to have a version as a snapshot
    // in the subscription so the customer can keep using the old version no matter what happens with the plan

    const updatedPlan = await opts.ctx.db
      .update(schema.plans)
      .set({
        description,
        active,
        defaultPlan: defaultPlan ?? false,
        enterprisePlan: enterprisePlan ?? false,
        updatedAtM: Date.now(),
      })
      .where(and(eq(schema.plans.id, id), eq(schema.plans.projectId, project.id)))
      .returning()
      .then((re) => re[0])

    if (!updatedPlan) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error updating plan",
      })
    }

    return {
      plan: updatedPlan,
    }
  })
