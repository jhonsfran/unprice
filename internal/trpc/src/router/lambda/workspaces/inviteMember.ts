import { TRPCError } from "@trpc/server"
import { inviteMembersSchema, invitesSelectBase } from "@unprice/db/validators"
import { InviteEmail, sendEmail } from "@unprice/email"
import { inviteMember as inviteMemberUseCase } from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"

export const inviteMember = protectedWorkspaceProcedure
  .input(inviteMembersSchema)
  .output(
    z.object({
      invite: invitesSelectBase.optional(),
    })
  )
  .mutation(async (opts) => {
    const { email, role, name } = opts.input
    const userId = opts.ctx.userId
    const workspace = opts.ctx.workspace

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    if (!role) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Role is required",
      })
    }

    const { err, val } = await inviteMemberUseCase(
      {
        db: opts.ctx.db,
        cache: opts.ctx.cache,
        logger: opts.ctx.logger,
        waitUntil: opts.ctx.waitUntil,
      },
      {
        email,
        role,
        name,
        userId,
        workspace: {
          id: workspace.id,
          slug: workspace.slug,
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
        message: "Cannot invite members to personal workspace, please upgrade to invite members",
      })
    }

    if (val.state === "already_member") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "User is already a member of the workspace",
      })
    }

    if (val.state === "inviter_not_found") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "User not found",
      })
    }

    if (val.state === "member_added") {
      return {
        invite: undefined,
      }
    }

    if (val.state !== "invite_created") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error inviting workspace member",
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
      invite: val.invite,
    }
  })
