import { TRPCError } from "@trpc/server"
import { z } from "zod"

import {
  featureSelectBaseSchema,
  planVersionFeatureSelectBaseSchema,
  planVersionSelectBaseSchema,
} from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const getById = protectedProjectProcedure
  .input(
    z.object({
      id: z.string(),
    })
  )
  .output(
    z.object({
      planVersionFeature: planVersionFeatureSelectBaseSchema.extend({
        planVersion: planVersionSelectBaseSchema,
        feature: featureSelectBaseSchema,
      }),
    })
  )
  .query(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const { plans } = opts.ctx.services

    const { err, val: planVersionFeatureData } = await plans.getPlanVersionFeatureByIdDetailed({
      id,
      projectId: project.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!planVersionFeatureData) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Plan version feature not found",
      })
    }

    return {
      planVersionFeature: planVersionFeatureData,
    }
  })
