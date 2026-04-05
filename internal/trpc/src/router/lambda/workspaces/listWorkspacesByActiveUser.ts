import { TRPCError } from "@trpc/server"
import { workspaceSelectBase } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProcedure } from "#trpc"

export const listWorkspacesByActiveUser = protectedProcedure
  .input(z.void())
  .output(
    z.object({
      workspaces: z.array(
        workspaceSelectBase.extend({
          role: z.string(),
          userId: z.string(),
        })
      ),
    })
  )
  .query(async (opts) => {
    const userId = opts.ctx.session?.user?.id
    const { workspaces: workspaceService } = opts.ctx.services

    if (!userId) {
      return { workspaces: [] }
    }

    const { err, val: workspaces } = await workspaceService.listWorkspacesByUser({
      userId,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      workspaces,
    }
  })
