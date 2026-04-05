import { TRPCError } from "@trpc/server"
import { featureSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getBySlug = protectedProjectProcedure
  .input(z.object({ slug: z.string() }))
  .output(z.object({ feature: featureSelectBaseSchema.optional() }))
  .query(async (opts) => {
    const { slug } = opts.input
    const project = opts.ctx.project
    const { features } = opts.ctx.services

    const { err, val: feature } = await features.getFeatureBySlug({
      projectId: project.id,
      slug,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      feature: feature ?? undefined,
    }
  })
