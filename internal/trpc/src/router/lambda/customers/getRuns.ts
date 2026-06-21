import { TRPCError } from "@trpc/server"
import {
  budgetRunSelectSchema,
  customerSelectSchema,
  searchParamsSchemaDataTable,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { unprice } from "#utils/unprice"
import { refreshRunningRuns } from "./refreshRunningRuns"

const getRunsOutputSchema = z.object({
  customer: customerSelectSchema,
  runs: budgetRunSelectSchema.array(),
  pageCount: z.number(),
})

export const getRuns = protectedProjectProcedure
  .input(
    searchParamsSchemaDataTable.extend({
      customerId: z.string(),
    })
  )
  .output(getRunsOutputSchema)
  .query(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx
    const { customers } = opts.ctx.services

    const result = await customers.getCustomerRuns({
      customerId,
      projectId: project.id,
      query: opts.input,
    })

    if (result.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    if (!result.val) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    const runs = await refreshRunningRuns({
      customerId,
      projectId: project.id,
      runs: result.val.runs,
      runsGet: unprice.runs.get,
      logger: opts.ctx.logger,
    })

    return getRunsOutputSchema.parse({
      customer: result.val.customer,
      runs,
      pageCount: result.val.pageCount,
    })
  })
