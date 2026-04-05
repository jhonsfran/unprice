import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const exist = protectedProjectProcedure
  .input(z.object({ slug: z.string(), id: z.string().optional() }))
  .output(
    z.object({
      exist: z.boolean(),
    })
  )
  .mutation(async (opts) => {
    const { slug, id } = opts.input
    const project = opts.ctx.project
    const { plans } = opts.ctx.services

    const { err, val: exists } = await plans.planExists({
      slug,
      id,
      projectId: project.id,
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
