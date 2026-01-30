import { TRPCError } from "@trpc/server"
import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { invitesSelectBase } from "@unprice/db/validators"
import { z } from "zod"

import { FEATURE_SLUGS } from "@unprice/config"
import { protectedWorkspaceProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

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

    opts.ctx.verifyRole(["OWNER"])

    // check if the customer has access to the feature
    const result = await featureGuard({
      customerId: workspace.unPriceCustomerId,
      featureSlug: FEATURE_SLUGS.ACCESS_PRO.SLUG,
      isMain: workspace.isMain,
      metadata: {
        action: "deleteInvite",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const deletedInvite = await opts.ctx.db
      .delete(schema.invites)
      .where(and(eq(schema.invites.email, email), eq(schema.invites.workspaceId, workspace.id)))
      .returning()
      .then((inv) => inv[0] ?? undefined)

    if (!deletedInvite) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting invite",
      })
    }

    return {
      invite: deletedInvite,
    }
  })
