import { TRPCError } from "@trpc/server"
import { membersSelectBase } from "@unprice/db/validators"
import { z } from "zod"

import { protectedWorkspaceProcedure } from "#trpc"

export const changeRoleMember = protectedWorkspaceProcedure
  .input(membersSelectBase.pick({ userId: true, role: true }))
  .output(z.object({ member: membersSelectBase.optional() }))
  .mutation(async (opts) => {
    const { userId, role } = opts.input
    const workspace = opts.ctx.workspace
    const actorRole = opts.ctx.member.role
    const { workspaces } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val, err } = await workspaces.changeMemberRole({
      workspaceId: workspace.id,
      userId,
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
          message: "Member not found",
        })
      case "last_owner":
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace must have at least one owner",
        })
      case "owner_role_forbidden":
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only workspace owners can assign the owner role",
        })
      case "ok":
        break
    }

    opts.ctx.waitUntil(
      Promise.all([
        opts.ctx.cache.workspaceGuard.remove(`workspace-guard:${workspace.id}:${userId}`),
        opts.ctx.cache.workspaceGuard.remove(`workspace-guard:${workspace.slug}:${userId}`),
      ])
    )

    return {
      member: val.member,
    }
  })
