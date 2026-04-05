import { TRPCError } from "@trpc/server"
import { planSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

export const remove = protectedProjectProcedure
  .input(planSelectBaseSchema.pick({ id: true }))
  .output(z.object({ plan: planSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const { plans } = opts.ctx.services
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val, err } = await plans.removePlanRecord({
      projectId: project.id,
      id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "published_conflict") {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "You cannot delete a plan that has published versions. Please deactivate it instead",
      })
    }

    if (val.state === "not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Plan not found",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting plan",
      })
    }

    return {
      plan: val.plan,
    }
  })
