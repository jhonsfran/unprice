import { TRPCError } from "@trpc/server"
import { searchParamsSchemaDataTable, selectApiKeySchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const listByActiveProject = protectedProjectProcedure
  .input(searchParamsSchemaDataTable)
  .output(
    z.object({
      apikeys: z.array(selectApiKeySchema),
      pageCount: z.number(),
    })
  )
  .query(async (opts) => {
    const project = opts.ctx.project
    const { apikeys } = opts.ctx.services

    const { err, val } = await apikeys.listApiKeysByProject({
      projectId: project.id,
      query: opts.input,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return val
  })
