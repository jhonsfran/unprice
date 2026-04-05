import { TRPCError } from "@trpc/server"
import { invitesSelectBase } from "@unprice/db/validators"
import { InviteEmail, sendEmail } from "@unprice/email"
import { resendInvite as resendInviteUseCase } from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"

export const resendInvite = protectedWorkspaceProcedure
  .input(invitesSelectBase.pick({ email: true }))
  .output(
    z.object({
      resended: z.boolean(),
    })
  )
  .mutation(async (opts) => {
    const { email } = opts.input
    const workspace = opts.ctx.workspace

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await resendInviteUseCase(
      {
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        email,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          isPersonal: workspace.isPersonal,
        },
      }
    )

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "personal_workspace_conflict") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot resend invites to personal workspace, please upgrade to invite members",
      })
    }

    if (val.state === "invite_not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Invite not found",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error resending invite",
      })
    }

    opts.ctx.waitUntil(
      sendEmail({
        subject: "You're invited to join Unprice",
        to: [email],
        react: InviteEmail({
          inviterName: val.inviterName,
          inviteeName: val.inviteeName ?? email,
          workspaceName: workspace.name,
        }),
      })
    )

    return {
      resended: true,
    }
  })
