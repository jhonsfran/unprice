import { TRPCError } from "@trpc/server"
import { planVersionSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

export const deactivate = protectedProjectProcedure
  .input(
    planVersionSelectBaseSchema
      .pick({
        id: true,
      })
      .required({ id: true })
  )
  .output(z.object({ planVersion: planVersionSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const { plans } = opts.ctx.services
    // only owner and admin can deactivate a plan version
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await plans.deactivatePlanVersionRecord({
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
        message: "version not found",
      })
    }

    if (val.state === "not_published") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "You can only deactivate a published version",
      })
    }

    if (val.state === "already_deactivated") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Version is already deactivated",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deactivating version",
      })
    }

    return {
      planVersion: val.planVersion,
    }
  })
