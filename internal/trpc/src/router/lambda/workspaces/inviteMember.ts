import { TRPCError } from "@trpc/server"
import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { inviteMembersSchema, invitesSelectBase } from "@unprice/db/validators"
import { InviteEmail, sendEmail } from "@unprice/email"
import { z } from "zod"

import { FEATURE_SLUGS } from "@unprice/config"
import { protectedWorkspaceProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

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
    const featureSlug = FEATURE_SLUGS.ACCESS_PRO.SLUG

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    // can't invite members if workspace is personal
    if (workspace.isPersonal) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot invite members to personal workspace, please upgrade to invite members",
      })
    }

    const result = await featureGuard({
      customerId: workspace.unPriceCustomerId,
      featureSlug,
      isMain: workspace.isMain,
      metadata: {
        action: "inviteMember",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const userByEmail = await opts.ctx.db.query.users.findFirst({
      where: eq(schema.users.email, email),
    })

    if (userByEmail) {
      const member = await opts.ctx.db.query.members.findFirst({
        where: and(
          eq(schema.members.userId, userByEmail.id),
          eq(schema.members.workspaceId, workspace.id)
        ),
      })

      if (member) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "User is already a member of the workspace",
        })
      }

      await opts.ctx.db
        .insert(schema.members)
        .values({
          userId: userByEmail.id,
          workspaceId: workspace.id,
          role: role,
        })
        .returning()

      opts.ctx.waitUntil(
        Promise.all([
          opts.ctx.cache.workspaceGuard.remove(`workspace-guard:${workspace.id}:${userByEmail.id}`),
          opts.ctx.cache.workspaceGuard.remove(
            `workspace-guard:${workspace.slug}:${userByEmail.id}`
          ),
        ])
      )

      return {
        invite: undefined,
      }
    }

    const user = await opts.ctx.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
    })

    if (!user) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "User not found",
      })
    }

    const memberInvited = await opts.ctx.db
      .insert(schema.invites)
      .values({
        email: email,
        workspaceId: workspace.id,
        role: role,
        name: name,
        invitedBy: userId,
      })
      .returning()
      .then((res) => {
        return res[0]
      })

    opts.ctx.waitUntil(
      sendEmail({
        subject: "You're invited to join Unprice",
        to: [email],
        react: InviteEmail({
          inviterName: user.name ?? user.email,
          inviteeName: name,
          workspaceName: workspace.name,
        }),
      })
    )

    return {
      invite: memberInvited,
    }
  })
