import { TRPCError } from "@trpc/server"
import { pageInsertBaseSchema, pageSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const update = protectedProjectProcedure
  .input(pageInsertBaseSchema.partial().required({ id: true }))
  .output(
    z.object({
      page: pageSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const {
      id,
      subdomain,
      customDomain,
      title,
      name,
      description,
      logo,
      logoType,
      colorPalette,
      faqs,
      copy,
      selectedPlans,
      ctaLink,
    } = opts.input
    const project = opts.ctx.project
    const { pages } = opts.ctx.services

    const { err: pageLookupErr, val: pageData } = await pages.getPageById({
      projectId: project.id,
      pageId: id,
    })

    if (pageLookupErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: pageLookupErr.message,
      })
    }

    if (!pageData?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "page not found",
      })
    }

    const { err: updateErr, val: updatedPage } = await pages.updatePage({
      pageId: id,
      projectId: project.id,
      subdomain,
      customDomain,
      description,
      name,
      title,
      copy,
      logo,
      colorPalette,
      faqs,
      selectedPlans,
      logoType,
      ctaLink,
    })

    if (updateErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: updateErr.message,
      })
    }

    if (!updatedPage) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error updating page",
      })
    }

    return {
      page: updatedPage,
    }
  })
