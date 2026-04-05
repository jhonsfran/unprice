import { TRPCError } from "@trpc/server"
import { invitesSelectBase } from "@unprice/db/validators"
import { z } from "zod"

import { protectedWorkspaceProcedure } from "#trpc"

export const changeRoleInvite = protectedWorkspaceProcedure
  .input(invitesSelectBase.pick({ email: true, role: true }))
  .output(z.object({ invite: invitesSelectBase.optional() }))
  .mutation(async (opts) => {
    const { email, role } = opts.input
    const workspace = opts.ctx.workspace
    const { workspaces } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val, err } = await workspaces.changeInviteRole({
      workspaceId: workspace.id,
      email,
      role,
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
        message: "Invite not found",
      })
    }

    return {
      invite: val.invite,
    }
  })
