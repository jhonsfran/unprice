import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { planVersionFeatureDragDropSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const getByPlanVersionId = protectedProjectProcedure
  .input(
    z.object({
      planVersionId: z.string(),
    })
  )
  .output(
    z.object({
      planVersionFeatures: planVersionFeatureDragDropSchema.array(),
    })
  )
  .query(async (opts) => {
    const { planVersionId } = opts.input
    const project = opts.ctx.project
    const { plans } = opts.ctx.services

    const { err, val } = await plans.listPlanVersionFeaturesByPlanVersionId({
      planVersionId,
      projectId: project.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "plan_version_not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Plan version not found",
      })
    }

    return {
      planVersionFeatures: val.planVersionFeatures,
    }
  })
