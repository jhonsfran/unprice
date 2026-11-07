import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import { z } from "zod"
import type { AnalyticsService } from "../../analytics"

export const getRejectedEventPayloadInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string().min(1),
  /** The journal's operation id of the refusal: `r:<idempotency key>`. */
  operationId: z.string().min(1),
  /** When the API journaled the refusal; bounds the scan. */
  handledAt: z.number().int(),
})

export const getRejectedEventPayloadOutputSchema = z
  .object({
    eventId: z.string(),
    operationId: z.string(),
    customerId: z.string(),
    rejectionReason: z.string().nullable(),
    /** The refused event and its rejection as the journal keeps them, pretty-printed. */
    payloadJson: z.string(),
    handledAt: z.number().int(),
  })
  .nullable()

export type GetRejectedEventPayloadInput = z.infer<typeof getRejectedEventPayloadInputSchema>
export type GetRejectedEventPayloadOutput = z.infer<typeof getRejectedEventPayloadOutputSchema>

export type GetRejectedEventPayloadDeps = {
  analytics: Pick<AnalyticsService, "getRejectedEvent">
}

const rejectedDataSchema = z.object({
  idempotencyKey: z.string().optional(),
  rejection: z.object({ code: z.string() }).partial().optional(),
})

/**
 * A refused usage event with what refused it, from the budget journal (ADR-0008 D7). Null until the
 * journal has the row: the API sends it after the response, and the table lags by minutes.
 */
export async function getRejectedEventPayload(
  deps: GetRejectedEventPayloadDeps,
  rawInput: GetRejectedEventPayloadInput
): Promise<Result<GetRejectedEventPayloadOutput, FetchError>> {
  const input = getRejectedEventPayloadInputSchema.parse(rawInput)
  const row = await deps.analytics.getRejectedEvent({
    projectId: input.projectId,
    customerId: input.customerId,
    operationId: input.operationId,
    handledAt: input.handledAt,
  })
  if (row.err) return Err(row.err)
  if (!row.val) return Ok(null)

  // A row whose export is not valid JSON has no payload to show: not found, not a 500.
  const data = parseJson(row.val.data)
  if (data === undefined) return Ok(null)
  const parsed = rejectedDataSchema.safeParse(data)
  return Ok(
    getRejectedEventPayloadOutputSchema.parse({
      eventId: (parsed.success && parsed.data.idempotencyKey) || row.val.operation_id,
      operationId: row.val.operation_id,
      customerId: input.customerId,
      rejectionReason: (parsed.success && parsed.data.rejection?.code) || null,
      payloadJson: JSON.stringify(data, null, 2),
      handledAt: row.val.timestamp.getTime(),
    })
  )
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
