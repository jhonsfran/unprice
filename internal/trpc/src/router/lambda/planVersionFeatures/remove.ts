import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { planVersionFeatureSelectBaseSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

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
    const { plans } = opts.ctx.services

    // only owner and admin can delete a feature
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await plans.removePlanVersionFeatureRecord({
      projectId: project.id,
      id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "feature version not found",
      })
    }

    if (val.state === "published_conflict") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Cannot delete a feature from a published version",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting feature",
      })
    }

    return {
      plan: val.planVersionFeature,
    }
  })
