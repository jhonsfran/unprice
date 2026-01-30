import { TRPCError } from "@trpc/server"
import * as schema from "@unprice/db/schema"
import { createSlug, newId } from "@unprice/db/utils"
import { pageInsertBaseSchema, pageSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"

import { FEATURE_SLUGS } from "@unprice/config"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const create = protectedProjectProcedure
  .input(pageInsertBaseSchema.omit({ ctaLink: true }))
  .output(
    z.object({
      page: pageSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const { name, subdomain, customDomain, description } = opts.input
    const project = opts.ctx.project
    const workspace = opts.ctx.project.workspace
    const customerId = workspace.unPriceCustomerId
    const featureSlug = FEATURE_SLUGS.PAGES.SLUG

    // only owner and admin can create a page
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const result = await featureGuard({
      customerId,
      featureSlug,
      isMain: workspace.isMain,
      metadata: {
        action: "create",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const pageId = newId("page")
    const slug = createSlug()

    const pageData = await opts.ctx.db
      .insert(schema.pages)
      .values({
        id: pageId,
        slug,
        name,
        projectId: project.id,
        description,
        subdomain,
        customDomain: customDomain || null,
        faqs: [],
        colorPalette: {
          primary: "#000000",
        },
        selectedPlans: [],
      })
      .returning()
      .catch((err) => {
        opts.ctx.logger.error(err)

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create page",
        })
      })
      .then((pageData) => {
        return pageData[0]
      })

    if (!pageData?.id) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "error creating page",
      })
    }

    // avoid reporting usage for flat features
    if (result.featureType !== "flat") {
      opts.ctx.waitUntil(
        reportUsageFeature({
          customerId,
          featureSlug,
          usage: 1,
          isMain: workspace.isMain,
          metadata: {
            action: "create",
          },
        })
      )
    }

    return {
      page: pageData,
    }
  })
