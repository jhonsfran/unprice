import { TRPCError } from "@trpc/server"
import { membersSelectBase } from "@unprice/db/validators"
import { z } from "zod"

import { protectedWorkspaceProcedure } from "#trpc"

export const deleteMember = protectedWorkspaceProcedure
  .input(
    z.object({
      userId: z.string(),
      workspaceId: z.string(),
    })
  )
  .output(
    z.object({
      member: membersSelectBase,
    })
  )
  .mutation(async (opts) => {
    const { userId, workspaceId } = opts.input
    const workspace = opts.ctx.workspace
    const { workspaces } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER"])

    if (workspace.id !== workspaceId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Workspace not found",
      })
    }

    if (workspace.isPersonal) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot delete yourself from personal workspace",
      })
    }

    const { err, val } = await workspaces.removeWorkspaceMember({
      workspaceId: workspace.id,
      userId,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "user_not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "User not found",
      })
    }

    if (val.state === "only_owner_conflict") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot delete the only owner of the workspace",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting member",
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
