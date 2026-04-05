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
    const { workspaces } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val, err } = await workspaces.changeMemberRole({
      workspaceId: workspace.id,
      userId,
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
        message: "Member not found",
      })
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
