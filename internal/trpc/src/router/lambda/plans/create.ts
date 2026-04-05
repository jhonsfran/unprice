import { TRPCError } from "@trpc/server"
import { planInsertBaseSchema, planSelectBaseSchema } from "@unprice/db/validators"
import { createPlan } from "@unprice/services/use-cases"
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

    const { err, val: planData } = await createPlan(
      {
        services: opts.ctx.services,
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        input: opts.input,
        projectId: project.id,
      }
    )

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
