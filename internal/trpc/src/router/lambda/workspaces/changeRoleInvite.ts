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
    const actorRole = opts.ctx.member.role
    const { workspaces } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val, err } = await workspaces.changeInviteRole({
      workspaceId: workspace.id,
      email,
      role,
      actorRole,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    switch (val.state) {
      case "not_found":
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invite not found",
        })
      case "owner_role_forbidden":
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only workspace owners can assign the owner role",
        })
      case "ok":
        return {
          invite: val.invite,
        }
    }
  })
