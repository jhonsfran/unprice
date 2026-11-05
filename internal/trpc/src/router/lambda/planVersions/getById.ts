import { TRPCError } from "@trpc/server"
import {
  featureSelectBaseSchema,
  planSelectBaseSchema,
  planVersionFeatureSelectBaseSchema,
  planVersionSelectBaseSchema,
} from "@unprice/db/validators"
import { planVersionPrices } from "@unprice/services/pricing"
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
    const { plans, rateCards } = opts.ctx.services

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

    // ADR-0008 D2: prices live on the version's rate card, never on the plan feature.
    const rows = await rateCards.rowsForVersions(project.id, [planVersionData], Date.now())
    const { flatPrice, displayPrices } = planVersionPrices(
      planVersionData.planFeatures,
      rows.get(planVersionData.id) ?? [],
      planVersionData.currency
    )

    return getByIdOutputSchema.parse({
      planVersion: {
        ...planVersionData,
        flatPrice,
        planFeatures: planVersionData.planFeatures.map((planFeature) => ({
          ...planFeature,
          displayPrice: displayPrices.get(planFeature.feature.slug) ?? null,
        })),
      },
    })
  })
