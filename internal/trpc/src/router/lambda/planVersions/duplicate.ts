import { TRPCError } from "@trpc/server"
import { planVersionSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

export const duplicate = protectedProjectProcedure
  .input(
    z.object({
      id: z.string(),
    })
  )
  .output(
    z.object({
      planVersion: planVersionSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const { plans } = opts.ctx.services

    // only owner and admin can duplicate a plan version
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await plans.duplicatePlanVersionRecord({
      projectId: project.id,
      id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Plan version not found",
      })
    }

    if (val.state === "default_plan_payment_method_conflict") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "default plan can't have a required payment method",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error duplicating version",
      })
    }

    return {
      planVersion: val.planVersion,
    }
  })
