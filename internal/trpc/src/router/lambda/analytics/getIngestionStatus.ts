import { TRPCError } from "@trpc/server"
import {
  getIngestionStatusInputSchema,
  getIngestionStatusOutputSchema,
  getIngestionStatus as getIngestionStatusUseCase,
} from "@unprice/services/use-cases"
import { protectedProjectProcedure } from "#trpc"

export const getIngestionStatus = protectedProjectProcedure
  .input(getIngestionStatusInputSchema.omit({ projectId: true }))
  .output(getIngestionStatusOutputSchema)
  .query(async (opts) => {
    const result = await getIngestionStatusUseCase(
      {
        analytics: opts.ctx.services.analytics,
      },
      { ...opts.input, projectId: opts.ctx.project.id }
    )

    if (result.err) {
      opts.ctx.logger.error(result.err, {
        context: "getIngestionStatus failed",
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
