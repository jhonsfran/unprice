import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const exist = protectedProjectProcedure
  .input(z.object({ slug: z.string() }))
  .output(z.object({ exist: z.boolean() }))
  .mutation(async (opts) => {
    const { slug } = opts.input
    const project = opts.ctx.project
    const { features } = opts.ctx.services

    const { err, val: exists } = await features.featureExistsBySlug({
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
      exist: exists,
    }
  })
