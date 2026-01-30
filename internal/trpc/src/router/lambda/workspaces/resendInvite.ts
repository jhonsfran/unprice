import { TRPCError } from "@trpc/server"
import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { invitesSelectBase } from "@unprice/db/validators"
import { InviteEmail, sendEmail } from "@unprice/email"
import { z } from "zod"

import { FEATURE_SLUGS } from "@unprice/config"
import { protectedWorkspaceProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

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
    const featureSlug = FEATURE_SLUGS.ACCESS_PRO.SLUG

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    // can't invite members if workspace is personal
    if (workspace.isPersonal) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot resend invites to personal workspace, please upgrade to invite members",
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

    const invite = await opts.ctx.db.query.invites.findFirst({
      where: and(eq(schema.invites.email, email), eq(schema.invites.workspaceId, workspace.id)),
      with: {
        invitedBy: true,
      },
    })

    if (!invite) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Invite not found",
      })
    }

    opts.ctx.waitUntil(
      sendEmail({
        subject: "You're invited to join Unprice",
        to: [email],
        react: InviteEmail({
          inviterName: invite.invitedBy.name ?? invite.invitedBy.email,
          inviteeName: invite.name,
          workspaceName: workspace.name,
        }),
      })
    )

    return {
      resended: true,
    }
  })
