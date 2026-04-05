import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { planInsertBaseSchema, planSelectBaseSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const update = protectedProjectProcedure
  .input(planInsertBaseSchema.required({ id: true }))
  .output(
    z.object({
      plan: planSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const { id, description, active, title, defaultPlan, enterprisePlan } = opts.input
    const project = opts.ctx.project
    const { plans } = opts.ctx.services
    const _workspace = opts.ctx.project.workspace

    // only owner and admin can update a plan
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    if (defaultPlan && enterprisePlan) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "A plan cannot be both a default and enterprise plan",
      })
    }

    const { err, val } = await plans.updatePlanRecord({
      projectId: project.id,
      id,
      description,
      active,
      title,
      defaultPlan,
      enterprisePlan,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "plan_not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "plan not found",
      })
    }

    if (val.state === "default_enterprise_conflict") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "A plan cannot be both a default and enterprise plan",
      })
    }

    if (val.state === "default_plan_exists") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "There is already a default plan for this app",
      })
    }

    if (val.state === "enterprise_plan_exists") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "There is already an enterprise plan for this app, create a new version instead",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error updating plan",
      })
    }

    return {
      plan: val.plan,
    }
  })
