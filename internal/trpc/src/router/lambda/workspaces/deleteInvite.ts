import { TRPCError } from "@trpc/server"
import { invitesSelectBase } from "@unprice/db/validators"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"

export const deleteInvite = protectedWorkspaceProcedure
  .input(
    z.object({
      email: z.string().email(),
    })
  )
  .output(
    z.object({
      invite: invitesSelectBase,
    })
  )
  .mutation(async (opts) => {
    const { email } = opts.input
    const workspace = opts.ctx.workspace
    const { workspaces } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER"])

    const { val, err } = await workspaces.deleteInvite({
      workspaceId: workspace.id,
      email,
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
