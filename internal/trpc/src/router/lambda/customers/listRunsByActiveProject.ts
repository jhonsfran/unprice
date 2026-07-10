import { TRPCError } from "@trpc/server"
import {
  budgetRunSelectSchema,
  customerSelectSchema,
  searchParamsSchemaDataTable,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

const listRunsByActiveProjectOutputSchema = z.object({
  runs: budgetRunSelectSchema
    .extend({
      customer: customerSelectSchema,
    })
    .array(),
  pageCount: z.number(),
})

export const listRunsByActiveProject = protectedProjectProcedure
  .input(searchParamsSchemaDataTable)
  .output(listRunsByActiveProjectOutputSchema)
  .query(async (opts) => {
    const { project } = opts.ctx
    const { budgetRuns } = opts.ctx.services

    const result = await budgetRuns.listRunsByProject({
      projectId: project.id,
      query: opts.input,
    })

    if (result.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    const runs = await budgetRuns.listRunsRefreshed({
      projectId: project.id,
      runs: result.val.runs,
      runsGet: unprice.runs.get,
    })

    return listRunsByActiveProjectOutputSchema.parse({
      runs,
      pageCount: result.val.pageCount,
    })
  })
