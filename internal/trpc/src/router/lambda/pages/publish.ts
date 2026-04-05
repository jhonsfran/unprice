import { TRPCError } from "@trpc/server"
import { pageSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const publish = protectedProjectProcedure
  .input(pageSelectBaseSchema.pick({ id: true }))
  .output(z.object({ page: pageSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const { pages } = opts.ctx.services

    // only owner can publish a page
    opts.ctx.verifyRole(["OWNER"])

    const { val, err } = await pages.publishPageRecord({
      projectId: project.id,
      pageId: id,
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
