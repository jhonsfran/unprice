import { TRPCError } from "@trpc/server"
import {
  getFailedIngestionEventPayloadInputSchema,
  getFailedIngestionEventPayloadOutputSchema,
  getFailedIngestionEventPayload as getFailedIngestionEventPayloadUseCase,
} from "@unprice/services/use-cases"
import { protectedProjectProcedure } from "#trpc"

export const getFailedIngestionEventPayload = protectedProjectProcedure
  .input(getFailedIngestionEventPayloadInputSchema.omit({ projectId: true }))
  .output(getFailedIngestionEventPayloadOutputSchema)
  .query(async (opts) => {
    const result = await getFailedIngestionEventPayloadUseCase(
      {
        analytics: opts.ctx.analytics,
      },
      {
        projectId: opts.ctx.project.id,
        canonicalAuditId: opts.input.canonicalAuditId,
      }
    )

    if (result.err) {
      opts.ctx.logger.error(result.err, {
        context: "getFailedIngestionEventPayload failed",
        project_id: opts.ctx.project.id,
        canonical_audit_id: opts.input.canonicalAuditId,
      })

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    return result.val
  })
