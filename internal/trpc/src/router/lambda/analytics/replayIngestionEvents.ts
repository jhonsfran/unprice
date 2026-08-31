import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { sdkErrorToTRPCCode } from "#utils/sdk-error"
import { unprice } from "#utils/unprice"

const replayIngestionEventsInputSchema = z.object({
  canonicalAuditIds: z.array(z.string()).min(1).max(50),
})

const replayIngestionEventsOutputSchema = z.object({
  replayed: z.number().int(),
  skipped: z.number().int(),
})

export const replayIngestionEvents = protectedProjectProcedure
  .input(replayIngestionEventsInputSchema)
  .output(replayIngestionEventsOutputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const canonicalAuditIds = Array.from(new Set(opts.input.canonicalAuditIds))
    const { result, error } = await unprice.ingestionEvents.replay({
      canonical_audit_ids: canonicalAuditIds,
      project_id: opts.ctx.project.id,
    })

    if (error || !result) {
      opts.ctx.logger.error(error?.message ?? "Failed to replay ingestion events from SDK", {
        canonical_audit_id_count: canonicalAuditIds.length,
        project_id: opts.ctx.project.id,
      })

      throw new TRPCError({
        code: sdkErrorToTRPCCode(error?.code),
        message: error?.message ?? "Failed to replay ingestion events",
      })
    }

    return {
      replayed: result.replayed,
      skipped: result.skipped,
    }
  })
