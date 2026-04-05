import { TRPCError } from "@trpc/server"
import { pageSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const uploadLogo = protectedProjectProcedure
  .input(
    z.object({
      name: z.string(),
      file: z.string().min(1),
      type: z.string().min(1),
    })
  )
  .output(
    z.object({
      page: pageSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const logo = opts.input.file
    const type = opts.input.type
    const { pages } = opts.ctx.services

    const { val, err } = await pages.uploadPageLogoByName({
      projectId: opts.ctx.project.id,
      name: opts.input.name,
      logo,
      logoType: type,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Page not found",
      })
    }

    return {
      page: val.page,
    }
  })
