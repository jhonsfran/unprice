import type { Analytics, IngestionReplayPayloadRow } from "@unprice/analytics"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import { z } from "zod"

export const getFailedIngestionEventPayloadInputSchema = z.object({
  projectId: z.string(),
  canonicalAuditId: z.string().min(1),
})

export const getFailedIngestionEventPayloadOutputSchema = z
  .object({
    eventId: z.string(),
    canonicalAuditId: z.string(),
    customerId: z.string(),
    failureStage: z.string().nullable(),
    failureReason: z.string().nullable(),
    payloadJson: z.string(),
    r2ObjectKey: z.string().nullable(),
    handledAt: z.number().int(),
  })
  .nullable()

export type GetFailedIngestionEventPayloadInput = z.infer<
  typeof getFailedIngestionEventPayloadInputSchema
>
export type GetFailedIngestionEventPayloadOutput = z.infer<
  typeof getFailedIngestionEventPayloadOutputSchema
>

export type GetFailedIngestionEventPayloadAnalytics = Pick<Analytics, "getIngestionReplayPayloads">

export type GetFailedIngestionEventPayloadDeps = {
  analytics: GetFailedIngestionEventPayloadAnalytics
}

type GetFailedIngestionEventPayloadFailure = FetchError

export async function getFailedIngestionEventPayload(
  deps: GetFailedIngestionEventPayloadDeps,
  rawInput: GetFailedIngestionEventPayloadInput
): Promise<Result<GetFailedIngestionEventPayloadOutput, GetFailedIngestionEventPayloadFailure>> {
  const input = getFailedIngestionEventPayloadInputSchema.parse(rawInput)
  const payloadResult = await wrapResult(
    deps.analytics.getIngestionReplayPayloads({
      project_id: input.projectId,
      canonical_audit_ids: input.canonicalAuditId,
    }),
    (error) =>
      new FetchError({
        message: error.message,
        retry: true,
        context: {
          url: "tinybird:v1_get_ingestion_replay_payloads",
          method: "GET",
          projectId: input.projectId,
          canonicalAuditId: input.canonicalAuditId,
        },
      })
  )

  if (payloadResult.err) {
    return Err(payloadResult.err)
  }

  const row = payloadResult.val.data?.[0]
  if (!row) {
    return Ok(null)
  }

  return Ok(getFailedIngestionEventPayloadOutputSchema.parse(mapReplayPayloadRow(row)))
}

function mapReplayPayloadRow(
  row: IngestionReplayPayloadRow
): NonNullable<GetFailedIngestionEventPayloadOutput> {
  return {
    eventId: row.event_id,
    canonicalAuditId: row.canonical_audit_id,
    customerId: row.customer_id,
    failureStage: row.failure_stage,
    failureReason: row.failure_reason,
    payloadJson: row.payload_json,
    r2ObjectKey: row.r2_object_key ?? null,
    handledAt: row.handled_at,
  }
}
