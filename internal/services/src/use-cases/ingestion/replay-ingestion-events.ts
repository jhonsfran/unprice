import { BaseError, Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import { z } from "zod"
import {
  type IngestionQueueMessage,
  type RawIngestionQueueClient,
  ingestionQueueMessageSchema,
} from "../../ingestion"

const replayRowSchema = z.object({
  payload_json: z.string(),
})

const replayResponseSchema = z.object({
  data: z.array(z.unknown()).optional(),
})

const REPLAY_ANALYTICS_URL = "tinybird:v1_get_ingestion_replay_payloads"

export const replayIngestionEventsInputSchema = z.object({
  canonicalAuditIds: z.array(z.string()).min(1).max(50),
  projectId: z.string(),
  requestId: z.string(),
})

export const replayIngestionEventsOutputSchema = z.object({
  replayed: z.number().int().min(0),
  skipped: z.number().int().min(0),
})

export const replayIngestionEventsErrorReasonSchema = z.enum([
  "invalid_payload",
  "project_mismatch",
])

export type ReplayIngestionEventsInput = z.infer<typeof replayIngestionEventsInputSchema>
export type ReplayIngestionEventsOutput = z.infer<typeof replayIngestionEventsOutputSchema>
export type ReplayIngestionEventsErrorReason = z.infer<
  typeof replayIngestionEventsErrorReasonSchema
>

export type ReplayIngestionEventsAnalytics = {
  getIngestionReplayPayloads(params: {
    project_id: string
    canonical_audit_ids: string
  }): Promise<{ data?: unknown[] }>
}

export type ReplayIngestionEventsDeps = {
  analytics: ReplayIngestionEventsAnalytics
  rawIngestionQueue: RawIngestionQueueClient
}

export type ReplayIngestionEventsFailure = ReplayIngestionEventsError | FetchError

export class ReplayIngestionEventsError extends BaseError<{
  reason: ReplayIngestionEventsErrorReason
}> {
  public override readonly name = "ReplayIngestionEventsError"
  public readonly retry = false
  public readonly reason: ReplayIngestionEventsErrorReason

  constructor(params: { message: string; reason: ReplayIngestionEventsErrorReason }) {
    super({ message: params.message, context: { reason: params.reason } })
    this.reason = params.reason
  }
}

export async function replayIngestionEvents(
  deps: ReplayIngestionEventsDeps,
  rawInput: ReplayIngestionEventsInput
): Promise<Result<ReplayIngestionEventsOutput, ReplayIngestionEventsFailure>> {
  const input = replayIngestionEventsInputSchema.parse(rawInput)
  const canonicalAuditIds = Array.from(new Set(input.canonicalAuditIds))
  const analyticsResult = await wrapResult(
    deps.analytics.getIngestionReplayPayloads({
      project_id: input.projectId,
      canonical_audit_ids: canonicalAuditIds.join(","),
    }),
    (error) =>
      new FetchError({
        message: `Failed to fetch ingestion replay payloads: ${error.message}`,
        retry: true,
        ...(error instanceof BaseError ? { cause: error } : {}),
        context: {
          url: REPLAY_ANALYTICS_URL,
          method: "GET",
          projectId: input.projectId,
          canonicalAuditIds,
          errorMessage: error.message,
        },
      })
  )

  if (analyticsResult.err) {
    return Err(analyticsResult.err)
  }

  const parsedResponse = replayResponseSchema.safeParse(analyticsResult.val)
  if (!parsedResponse.success) {
    return Err(
      new FetchError({
        message: "Ingestion replay analytics response is invalid",
        retry: false,
        context: {
          url: REPLAY_ANALYTICS_URL,
          method: "GET",
          projectId: input.projectId,
          canonicalAuditIds,
          issues: parsedResponse.error.issues,
        },
      })
    )
  }

  const messages: IngestionQueueMessage[] = []

  for (const [rowIndex, row] of (parsedResponse.data.data ?? []).entries()) {
    const parsedRow = replayRowSchema.safeParse(row)
    if (!parsedRow.success) {
      return Err(
        new FetchError({
          message: "Ingestion replay analytics row is invalid",
          retry: false,
          context: {
            url: REPLAY_ANALYTICS_URL,
            method: "GET",
            projectId: input.projectId,
            canonicalAuditIds,
            rowIndex,
            issues: parsedRow.error.issues,
          },
        })
      )
    }

    let payload: unknown
    try {
      payload = JSON.parse(parsedRow.data.payload_json)
    } catch {
      return Err(
        new ReplayIngestionEventsError({
          reason: "invalid_payload",
          message: "Replay payload is not valid JSON",
        })
      )
    }

    const parsedMessage = ingestionQueueMessageSchema.safeParse(payload)
    if (!parsedMessage.success) {
      return Err(
        new ReplayIngestionEventsError({
          reason: "invalid_payload",
          message: "Replay payload is not a valid ingestion queue message",
        })
      )
    }

    if (parsedMessage.data.projectId !== input.projectId) {
      return Err(
        new ReplayIngestionEventsError({
          reason: "project_mismatch",
          message: "Replay payload project does not match request project",
        })
      )
    }

    messages.push({
      ...parsedMessage.data,
      requestId: input.requestId,
    })
  }

  if (messages.length > canonicalAuditIds.length) {
    return Err(
      new FetchError({
        message: "Ingestion replay analytics response exceeded requested cardinality",
        retry: false,
        context: {
          url: REPLAY_ANALYTICS_URL,
          method: "GET",
          projectId: input.projectId,
          canonicalAuditIds,
          requestedCount: canonicalAuditIds.length,
          receivedCount: messages.length,
        },
      })
    )
  }

  let alreadySent = 0
  for (const message of messages) {
    const sendResult = await wrapResult(
      deps.rawIngestionQueue.send(message),
      (error) =>
        new FetchError({
          message: "Failed to enqueue ingestion event",
          retry: true,
          ...(error instanceof BaseError ? { cause: error } : {}),
          context: {
            url: "queue:raw_ingestion",
            method: "SEND",
            projectId: input.projectId,
            eventId: message.id,
            idempotencyKey: message.idempotencyKey,
            alreadySent,
            errorMessage: error.message,
          },
        })
    )

    if (sendResult.err) {
      return Err(sendResult.err)
    }

    alreadySent++
  }

  return Ok({
    replayed: messages.length,
    skipped: canonicalAuditIds.length - messages.length,
  })
}
