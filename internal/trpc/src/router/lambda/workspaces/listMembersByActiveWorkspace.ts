import { TRPCError } from "@trpc/server"
import { listMembersSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedWorkspaceProcedure } from "#trpc"

export const listMembersByActiveWorkspace = protectedWorkspaceProcedure
  .input(z.void())
  .output(
    z.object({
      members: z.array(listMembersSchema),
    })
  )
  .query(async (opts) => {
    const workspace = opts.ctx.workspace
    const { workspaces } = opts.ctx.services

    const { err, val: members } = await workspaces.listWorkspaceMembers({
      workspaceId: workspace.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      members,
    }
  })
