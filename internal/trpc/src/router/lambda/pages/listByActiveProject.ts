import { TRPCError } from "@trpc/server"
import { pageSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

export const listByActiveProject = protectedProjectProcedure
  .input(
    z.object({
      fromDate: z.number().optional(),
      toDate: z.number().optional(),
    })
  )
  .output(
    z.object({
      pages: z.array(pageSelectBaseSchema.extend({})),
    })
  )
  .query(async (opts) => {
    const { fromDate, toDate } = opts.input
    const project = opts.ctx.project
    const { pages: pagesService } = opts.ctx.services

    const { err, val: pages } = await pagesService.listPagesByProject({
      projectId: project.id,
      fromDate,
      toDate,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      pages,
    }
  })
