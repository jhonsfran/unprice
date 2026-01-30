import { TRPCError } from "@trpc/server"
import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { pageSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"

import { FEATURE_SLUGS } from "@unprice/config"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

export const publish = protectedProjectProcedure
  .input(pageSelectBaseSchema.pick({ id: true }))
  .output(z.object({ page: pageSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const workspace = opts.ctx.project.workspace
    const customerId = workspace.unPriceCustomerId
    const featureSlug = FEATURE_SLUGS.PAGES.SLUG

    // only owner can publish a page
    opts.ctx.verifyRole(["OWNER"])

    // check if the customer has access to the feature
    const result = await featureGuard({
      customerId,
      featureSlug,
      metadata: {
        action: "publish",
      },
      isMain: workspace.isMain,
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const publishedPage = await opts.ctx.db
      .update(schema.pages)
      .set({
        published: true,
      })
      .where(and(eq(schema.pages.projectId, project.id), eq(schema.pages.id, id)))
      .returning()
      .then((data) => data[0])

    if (!publishedPage) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error publishing page",
      })
    }

    return {
      page: publishedPage,
    }
  })
