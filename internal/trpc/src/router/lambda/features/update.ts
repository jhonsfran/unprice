import { TRPCError } from "@trpc/server"
import { featureSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const update = protectedProjectProcedure
  .input(
    featureSelectBaseSchema
      .pick({ id: true, title: true, description: true, unitOfMeasure: true, meterConfig: true })
      .partial({
        description: true,
        unitOfMeasure: true,
        meterConfig: true,
      })
  )
  .output(z.object({ feature: featureSelectBaseSchema }))
  .mutation(async (opts) => {
    const { title, id, description, unitOfMeasure, meterConfig } = opts.input
    const project = opts.ctx.project
    const { features } = opts.ctx.services
    const hasMeterConfig = Object.prototype.hasOwnProperty.call(opts.input, "meterConfig")

    const { err, val } = await features.updateFeatureRecord({
      projectId: project.id,
      id,
      title,
      description,
      unitOfMeasure,
      meterConfig,
      hasMeterConfig,
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
