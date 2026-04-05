import { TRPCError } from "@trpc/server"
import { pageInsertBaseSchema, pageSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

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
    const { pages } = opts.ctx.services

    // only owner and admin can create a page
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val: pageData, err } = await pages.createPageRecord({
      projectId: project.id,
      name,
      subdomain,
      customDomain,
      description,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      page: pageData,
    }
  })
