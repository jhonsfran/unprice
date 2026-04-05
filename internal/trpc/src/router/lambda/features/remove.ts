import { TRPCError } from "@trpc/server"
import { featureSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const remove = protectedProjectProcedure
  .input(featureSelectBaseSchema.pick({ id: true }))
  .output(z.object({ feature: featureSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const { features } = opts.ctx.services

    const { val, err } = await features.removeFeatureById({
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
        message: "Feature not found",
      })
    }

    return {
      feature: val.feature,
    }
  })
