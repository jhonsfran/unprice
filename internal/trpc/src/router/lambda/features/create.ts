import { TRPCError } from "@trpc/server"
import { featureInsertBaseSchema, featureSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const create = protectedProjectProcedure
  .input(featureInsertBaseSchema)
  .output(z.object({ feature: featureSelectBaseSchema }))
  .mutation(async (opts) => {
    const { description, slug, title, unitOfMeasure, meterConfig } = opts.input
    const project = opts.ctx.project
    const { features } = opts.ctx.services

    const { val: featureData, err } = await features.createFeatureRecord({
      projectId: project.id,
      slug,
      title,
      description,
      unitOfMeasure,
      meterConfig,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      feature: featureData,
    }
  })
