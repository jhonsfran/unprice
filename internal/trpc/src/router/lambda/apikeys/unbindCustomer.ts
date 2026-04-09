import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const unbindCustomer = protectedProjectProcedure
  .input(
    z.object({
      apikeyId: z.string(),
    })
  )
  .output(
    z.object({
      success: z.boolean(),
    })
  )
  .mutation(async (opts) => {
    const { apikeyId } = opts.input
    const { project, services } = opts.ctx

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val, err } = await services.apikeys.unbindCustomer({
      apikeyId,
      projectId: project.id,
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
        message: "API key not found",
      })
    }

    return { success: true }
  })
