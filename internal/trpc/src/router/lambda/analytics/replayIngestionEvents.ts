import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { createProjectScopedUnpriceClient } from "#utils/unprice"

const replayIngestionEventsInputSchema = z.object({
  canonicalAuditIds: z.array(z.string()).min(1).max(50),
})

const replayIngestionEventsOutputSchema = z.object({
  replayed: z.number().int(),
  skipped: z.number().int(),
})

function toTRPCErrorCode(
  code: string | undefined
):
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL_SERVER_ERROR" {
  switch (code) {
    case "BAD_REQUEST":
      return "BAD_REQUEST"
    case "UNAUTHORIZED":
      return "UNAUTHORIZED"
    case "FORBIDDEN":
      return "FORBIDDEN"
    case "NOT_FOUND":
      return "NOT_FOUND"
    case "RATE_LIMITED":
    case "TOO_MANY_REQUESTS":
      return "TOO_MANY_REQUESTS"
    default:
      return "INTERNAL_SERVER_ERROR"
  }
}

export const replayIngestionEvents = protectedProjectProcedure
  .input(replayIngestionEventsInputSchema)
  .output(replayIngestionEventsOutputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const canonicalAuditIds = Array.from(new Set(opts.input.canonicalAuditIds))
    const client = createProjectScopedUnpriceClient(opts.ctx.project.id)
    const { result, error } = await client.replayFailedIngestionEvents({
      canonical_audit_ids: canonicalAuditIds,
    })

    if (error || !result) {
      opts.ctx.logger.error(error?.message ?? "Failed to replay ingestion events from SDK", {
        canonical_audit_id_count: canonicalAuditIds.length,
        project_id: opts.ctx.project.id,
      })

      throw new TRPCError({
        code: toTRPCErrorCode(error?.code),
        message: error?.message ?? "Failed to replay ingestion events",
      })
    }

    return {
      replayed: result.replayed,
      skipped: result.skipped,
    }
  })
