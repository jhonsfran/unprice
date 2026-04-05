import { TRPCError } from "@trpc/server"
import { pageSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"

import { publicProcedure } from "#trpc"

/// public endpoint for getting a page by domain
export const getByDomain = publicProcedure
  .input(
    z.object({
      domain: z.string(),
    })
  )
  .output(
    z.object({
      page: pageSelectBaseSchema.optional(),
    })
  )
  .query(async (opts) => {
    const { domain } = opts.input
    const { pages } = opts.ctx.services

    const { err, val: pageData } = await pages.getPageByDomain({
      domain,
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
