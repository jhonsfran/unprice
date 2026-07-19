import { TRPCError } from "@trpc/server"
import { workspaceSelectBase } from "@unprice/db/validators"
import { z } from "zod"

import { protectedWorkspaceProcedure } from "#trpc"
import { signOutCustomer } from "#utils/shared"

export const deleteWorkspace = protectedWorkspaceProcedure
  .input(workspaceSelectBase.pick({ id: true }))
  .output(z.object({ workspace: workspaceSelectBase.optional() }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const workspace = opts.ctx.workspace
    const { projects, workspaces } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER"])

    if (workspace.isMain) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot delete main workspace",
      })
    }

    if (workspace.id !== id) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "This id is not the active workspace",
      })
    }

    if (workspace?.isPersonal) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot delete personal workspace. Contact support to delete your account.",
      })
    }

    const { err: mainProjectErr, val: mainProject } = await projects.getMainProject()

    if (mainProjectErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: mainProjectErr.message,
      })
    }

    if (!mainProject?.id) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Main project not found",
      })
    }

    const signOutResult = await signOutCustomer({
      input: {
        customerId: workspace.unPriceCustomerId,
        projectId: mainProject.id,
      },
      ctx: opts.ctx,
    })

    if (!signOutResult.success) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: signOutResult.message ?? "Error signing out customer",
      })
    }

    const { err: deleteErr, val: deletedWorkspace } = await workspaces.deactivateWorkspaceById({
      workspaceId: workspace.id,
    })

    if (deleteErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: deleteErr.message,
      })
    }

    if (!deletedWorkspace) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting workspace",
      })
    }

    return {
      workspace: deletedWorkspace,
    }
  })
