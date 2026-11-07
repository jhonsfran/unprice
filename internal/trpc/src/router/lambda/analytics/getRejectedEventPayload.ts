import { TRPCError } from "@trpc/server"
import {
  getRejectedEventPayloadInputSchema,
  getRejectedEventPayloadOutputSchema,
  getRejectedEventPayload as getRejectedEventPayloadUseCase,
} from "@unprice/services/use-cases"
import { protectedProjectProcedure } from "#trpc"

export const getRejectedEventPayload = protectedProjectProcedure
  .input(getRejectedEventPayloadInputSchema.omit({ projectId: true }))
  .output(getRejectedEventPayloadOutputSchema)
  .query(async (opts) => {
    const result = await getRejectedEventPayloadUseCase(
      { analytics: opts.ctx.services.analytics },
      { ...opts.input, projectId: opts.ctx.project.id }
    )

    if (result.err) {
      opts.ctx.logger.error(result.err, {
        context: "getRejectedEventPayload failed",
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
