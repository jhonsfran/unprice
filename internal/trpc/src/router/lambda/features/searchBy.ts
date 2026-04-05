import { TRPCError } from "@trpc/server"
import { featureSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
export const searchBy = protectedProjectProcedure
  .input(
    z.object({
      search: z.string().optional(),
    })
  )
  .output(z.object({ features: z.array(featureSelectBaseSchema) }))
  .query(async (opts) => {
    const { search } = opts.input
    const project = opts.ctx.project
    const { features: featureService } = opts.ctx.services

    const { err, val: features } = await featureService.searchFeaturesByProject({
      projectId: project.id,
      search,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      features: features,
    }
  })
