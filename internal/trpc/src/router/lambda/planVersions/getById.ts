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
        /** The feature's current price on the version's rate card; null without a row. */
        displayPrice: z.string().nullable(),
        displayFeatureText: z.string(),
      })
    ),
    /** The flat features' flat rows on the version's rate card, summed and formatted. */
    flatPrice: z.string(),
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

    const { err, val: planVersionData } = await plans.getPlanVersionWithPrices({
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

    return getByIdOutputSchema.parse({ planVersion: planVersionData })
  })
