import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const revoke = protectedProjectProcedure
  .input(z.object({ ids: z.string().array() }))
  .output(z.object({ success: z.boolean(), numRevoked: z.number() }))
  .mutation(async (opts) => {
    const { ids } = opts.input
    const project = opts.ctx.project
    const { apikeys } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val, err } = await apikeys.revokeApiKeys({
      projectId: project.id,
      ids,
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
        message: "API key not found or already revoked",
      })
    }

    return { success: true, numRevoked: val.numRevoked }
  })
