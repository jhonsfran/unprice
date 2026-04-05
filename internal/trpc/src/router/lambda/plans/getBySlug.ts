import { TRPCError } from "@trpc/server"
import { planSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getBySlug = protectedProjectProcedure
  .input(z.object({ slug: z.string() }))
  .output(
    z.object({
      plan: planSelectBaseSchema,
    })
  )
  .query(async (opts) => {
    const { slug } = opts.input
    const project = opts.ctx.project
    const { plans } = opts.ctx.services

    const { err, val: plan } = await plans.getPlanBySlug({
      slug,
      projectId: project.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!plan) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Plan not found",
      })
    }

    return {
      plan: plan,
    }
  })
