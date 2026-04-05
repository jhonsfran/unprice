import { TRPCError } from "@trpc/server"
import { pageSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
export const getById = protectedProjectProcedure
  .input(
    z.object({
      id: z.string(),
    })
  )
  .output(
    z.object({
      page: pageSelectBaseSchema.optional(),
    })
  )
  .query(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const { pages } = opts.ctx.services

    const { err, val: pageData } = await pages.getPageById({
      projectId: project.id,
      pageId: id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      page: pageData ?? undefined,
    }
  })
