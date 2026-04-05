import { TRPCError } from "@trpc/server"
import {
  planSelectBaseSchema,
  planVersionSelectBaseSchema,
  projectSelectBaseSchema,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getById = protectedProjectProcedure
  .input(z.object({ id: z.string() }))
  .output(
    z.object({
      plan: planSelectBaseSchema.extend({
        versions: z.array(planVersionSelectBaseSchema),
        project: projectSelectBaseSchema,
      }),
    })
  )
  .query(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const { plans } = opts.ctx.services

    const { err, val: plan } = await plans.getPlanById({
      id,
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
