import { TRPCError } from "@trpc/server"
import {
  featureSelectBaseSchema,
  planSelectBaseSchema,
  planVersionFeatureSelectBaseSchema,
  planVersionSelectBaseSchema,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

const getByIdOutputSchema = z.object({
  planVersion: planVersionSelectBaseSchema.extend({
    plan: planSelectBaseSchema,
    planFeatures: z.array(
      planVersionFeatureSelectBaseSchema.extend({
        feature: featureSelectBaseSchema,
      })
    ),
  }),
})

export const getById = protectedProjectProcedure
  .input(
    z.object({
      id: z.string(),
      projectSlug: z.string().optional(),
    })
  )
  .output(getByIdOutputSchema)
  .query(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const { plans } = opts.ctx.services

    const { err, val: planVersionData } = await plans.getPlanVersionByIdDetailed({
      planVersionId: id,
      projectId: project.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!planVersionData) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Plan version not found",
      })
    }

    return getByIdOutputSchema.parse({
      planVersion: planVersionData,
    })
  })
