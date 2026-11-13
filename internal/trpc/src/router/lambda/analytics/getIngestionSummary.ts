import { TRPCError } from "@trpc/server"
import {
  getIngestionSummaryInputSchema,
  getIngestionSummaryOutputSchema,
  getIngestionSummary as getIngestionSummaryUseCase,
} from "@unprice/services/use-cases"
import { protectedProjectProcedure } from "#trpc"

export const getIngestionSummary = protectedProjectProcedure
  .input(getIngestionSummaryInputSchema.omit({ projectId: true }))
  .output(getIngestionSummaryOutputSchema)
  .query(async (opts) => {
    const result = await getIngestionSummaryUseCase(
      {
        budgetJournal: opts.ctx.services.budgetJournal,
      },
      { ...opts.input, projectId: opts.ctx.project.id }
    )

    if (result.err) {
      opts.ctx.logger.error(result.err, {
        context: "getIngestionSummary failed",
        project_id: opts.ctx.project.id,
        ...(opts.input.customerId ? { customer_id: opts.input.customerId } : {}),
      })

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    return result.val
  })
