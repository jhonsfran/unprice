import { TRPCError } from "@trpc/server"
import { invitesSelectBase } from "@unprice/db/validators"
import { z } from "zod"

import { protectedWorkspaceProcedure } from "#trpc"

export const listInvitesByActiveWorkspace = protectedWorkspaceProcedure
  .input(z.void())
  .output(
    z.object({
      invites: z.array(invitesSelectBase),
    })
  )
  .query(async (opts) => {
    const workspace = opts.ctx.workspace
    const { workspaces } = opts.ctx.services

    const { err, val: invites } = await workspaces.listWorkspaceInvites({
      workspaceId: workspace.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      invites,
    }
  })
