import { TRPCError } from "@trpc/server"
import { planInsertBaseSchema, planSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"


export const create = protectedProjectProcedure
  .input(planInsertBaseSchema)
  .output(
    z.object({
      plan: planSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const project = opts.ctx.project

    // only owner and admin can create a plan
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { plans } = opts.ctx.services

    const { err, val: planData } = await plans.createPlan({
      input: opts.input,
      projectId: project.id,
    })

    if (err) {
      throw new TRPCError({
        code: "CONFLICT",
        message: err.message,
      })
    }

    return {
      plan: planData,
    }
  })
