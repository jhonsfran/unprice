import { TRPCError } from "@trpc/server"
import { workspaceSelectBase } from "@unprice/db/validators"
import { z } from "zod"

import { protectedWorkspaceProcedure } from "#trpc"

export const getBySlug = protectedWorkspaceProcedure
  .input(workspaceSelectBase.pick({ slug: true }))
  .output(
    z.object({
      workspace: workspaceSelectBase,
    })
  )
  .query(async (opts) => {
    const { slug } = opts.input
    const { workspaces } = opts.ctx.services

    const { err, val: workspaceData } = await workspaces.getWorkspaceBySlug({
      slug,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!workspaceData) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Workspace not found",
      })
    }

    return {
      workspace: workspaceData,
    }
  })
