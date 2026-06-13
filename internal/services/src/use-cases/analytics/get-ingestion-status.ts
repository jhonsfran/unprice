import type { Analytics, IngestionLiveRow, IngestionRecentEventRow } from "@unprice/analytics"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import { z } from "zod"
import { aiEvidenceSchema } from "./ai-contracts"

export const getIngestionStatusWindowSchema = z
  .object({
    from: z.number().int(),
    to: z.number().int(),
  })
  .refine((window) => window.from < window.to, {
    message: "window.to must be greater than window.from",
    path: ["to"],
  })

export const getIngestionStatusCursorSchema = z.object({
  handledAt: z.number().int(),
  canonicalAuditId: z.string(),
})

export const getIngestionStatusInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string().optional(),
  window: getIngestionStatusWindowSchema,
  cursor: getIngestionStatusCursorSchema.nullish(),
  filter: z
    .object({
      sourceId: z.string().optional(),
      eventSlug: z.string().optional(),
      state: z.enum(["processed", "rejected", "failed"]).optional(),
    })
    .default({}),
  limit: z.number().int().min(1).max(100).default(50),
})

export const getIngestionStatusOutputSchema = z.object({
  window: z.object({ from: z.number().int(), to: z.number().int() }),
  totals: z.object({
    processed: z.number().int(),
    rejected: z.number().int(),
    failed: z.number().int(),
    total: z.number().int(),
  }),
  successRate: z.number(),
  freshness: z.object({
    generatedAt: z.number().int(),
    dataFrom: z.number().int().nullable(),
    dataTo: z.number().int().nullable(),
    latestHandledAt: z.number().int().nullable(),
    secondsSinceLatest: z.number().nullable(),
  }),
  live: z.array(
    z.object({
      second: z.string(),
      processed: z.number().int(),
      rejected: z.number().int(),
      failed: z.number().int(),
      total: z.number().int(),
    })
  ),
  rejections: z.array(
    z.object({
      rejectionReason: z.string().nullable(),
      eventSlug: z.string(),
      sourceId: z.string(),
      sourceType: z.string(),
      eventCount: z.number().int(),
      lastSeenAt: z.number().int(),
    })
  ),
  recentEvents: z.array(
    z.object({
      eventId: z.string(),
      canonicalAuditId: z.string(),
      customerId: z.string(),
      eventSlug: z.string(),
      sourceType: z.string(),
      sourceId: z.string(),
      state: z.enum(["processed", "rejected", "failed"]),
      rejectionReason: z.string().nullable(),
      failureStage: z.string().nullable(),
      failureReason: z.string().nullable(),
      failureMessage: z.string().nullable(),
      replayable: z.boolean(),
      timestamp: z.number().int(),
      receivedAt: z.number().int(),
      handledAt: z.number().int(),
    })
  ),
  nextCursor: getIngestionStatusCursorSchema.nullable(),
  answer: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.array(aiEvidenceSchema),
  warnings: z.array(z.string()),
  nextActions: z.array(z.string()),
})

export type GetIngestionStatusInput = z.infer<typeof getIngestionStatusInputSchema>
export type GetIngestionStatusOutput = z.infer<typeof getIngestionStatusOutputSchema>
type IngestionStatusCursor = z.infer<typeof getIngestionStatusCursorSchema>

export type GetIngestionStatusAnalytics = Pick<
  Analytics,
  "getIngestionLive" | "getIngestionRejections" | "getIngestionRecent"
>

export type GetIngestionStatusDeps = {
  analytics: GetIngestionStatusAnalytics
  now?: () => number
}

type GetIngestionStatusFailure = FetchError
type IngestionStatusFilter = GetIngestionStatusInput["filter"]

export async function getIngestionStatus(
  deps: GetIngestionStatusDeps,
  rawInput: GetIngestionStatusInput
): Promise<Result<GetIngestionStatusOutput, GetIngestionStatusFailure>> {
  const input = getIngestionStatusInputSchema.parse(rawInput)
  const baseWindowQuery = {
    project_id: input.projectId,
    ...(input.customerId ? { customer_id: input.customerId } : {}),
    from_ts: input.window.from,
    to_ts: input.window.to,
  }
  const filterQuery = toTinybirdFilter(input.filter)

  const analyticsResult = await wrapResult(
    Promise.all([
      deps.analytics.getIngestionLive({
        ...baseWindowQuery,
        ...filterQuery,
      }),
      deps.analytics.getIngestionRejections({
        ...baseWindowQuery,
        ...filterQuery,
        limit: input.limit,
      }),
      deps.analytics.getIngestionRecent({
        ...baseWindowQuery,
        ...filterQuery,
        ...toTinybirdCursor(input.cursor),
        limit: input.limit + 1,
      }),
    ]),
    (error) =>
      new FetchError({
        message: error.message,
        retry: true,
        context: {
          url: "tinybird:v1_get_ingestion_status",
          method: "GET",
          projectId: input.projectId,
          customerId: input.customerId,
        },
      })
  )

  if (analyticsResult.err) {
    return Err(analyticsResult.err)
  }

  const [liveResponse, rejectionsResponse, recentResponse] = analyticsResult.val
  const live = (liveResponse.data ?? []).map(mapLiveRow)
  const rejections =
    input.filter.state === "processed"
      ? []
      : (rejectionsResponse.data ?? [])
          .filter((row) => matchesFilter({ ...row, state: "rejected" }, input.filter))
          .slice(0, input.limit)
          .map((row) => ({
            rejectionReason: row.rejection_reason,
            eventSlug: row.event_slug,
            sourceId: row.source_id,
            sourceType: row.source_type,
            eventCount: row.event_count,
            lastSeenAt: row.last_seen_at,
          }))
  const recentRows = (recentResponse.data ?? [])
    .filter((row) => isInWindow(row.handled_at, input.window))
    .filter((row) => matchesFilter(row, input.filter))
  const recentEvents = recentRows.slice(0, input.limit).map(mapRecentEventRow)
  const nextCursor = getNextCursor(recentRows, input.limit)
  const totals = deriveTotals({ live, rejections, recentEvents })
  const successRate = totals.total === 0 ? 0 : totals.processed / totals.total
  const latestHandledAt = getLatestHandledAt({ recentEvents, live, rejections })
  const now = deps.now?.() ?? Date.now()

  const output: GetIngestionStatusOutput = {
    window: input.window,
    totals,
    successRate,
    freshness: {
      generatedAt: now,
      dataFrom: input.window.from,
      dataTo: latestHandledAt ?? input.window.to,
      latestHandledAt,
      secondsSinceLatest:
        latestHandledAt === null ? null : Math.max(0, Math.floor((now - latestHandledAt) / 1000)),
    },
    live,
    rejections,
    recentEvents,
    nextCursor,
    answer: buildAnswer({
      projectId: input.projectId,
      customerId: input.customerId,
      window: input.window,
      totals,
      successRate,
    }),
    confidence: totals.total > 0 ? "high" : "low",
    evidence: buildEvidence({
      input,
      latestHandledAt,
      live,
      rejections,
      recentEvents,
    }),
    warnings: buildWarnings({ totals }),
    nextActions: buildNextActions({ totals, rejections }),
  }

  return Ok(getIngestionStatusOutputSchema.parse(output))
}

function mapLiveRow(row: IngestionLiveRow): GetIngestionStatusOutput["live"][number] {
  return {
    second: row.second,
    processed: row.processed,
    rejected: row.rejected,
    failed: row.failed ?? 0,
    total: row.total,
  }
}

function mapRecentEventRow(
  row: IngestionRecentEventRow
): GetIngestionStatusOutput["recentEvents"][number] {
  return {
    eventId: row.event_id,
    canonicalAuditId: row.canonical_audit_id,
    customerId: row.customer_id,
    eventSlug: row.event_slug,
    sourceType: row.source_type,
    sourceId: row.source_id,
    state: row.state,
    rejectionReason: row.rejection_reason,
    failureStage: row.failure_stage ?? null,
    failureReason: row.failure_reason ?? null,
    failureMessage: row.failure_message ?? null,
    replayable: row.replayable ?? false,
    timestamp: row.timestamp,
    receivedAt: row.received_at,
    handledAt: row.handled_at,
  }
}

function toCursor(row: IngestionRecentEventRow): IngestionStatusCursor {
  return {
    handledAt: row.handled_at,
    canonicalAuditId: row.canonical_audit_id,
  }
}

function getNextCursor(
  rows: IngestionRecentEventRow[],
  limit: number
): IngestionStatusCursor | null {
  if (rows.length <= limit) {
    return null
  }

  const lastVisibleRow = rows[limit - 1]
  return lastVisibleRow ? toCursor(lastVisibleRow) : null
}

function matchesFilter(
  row: { source_id: string; event_slug: string; state?: "processed" | "rejected" | "failed" },
  filter: IngestionStatusFilter
): boolean {
  if (filter.sourceId && row.source_id !== filter.sourceId) {
    return false
  }

  if (filter.eventSlug && row.event_slug !== filter.eventSlug) {
    return false
  }

  if (filter.state && row.state && row.state !== filter.state) {
    return false
  }

  return true
}

function toTinybirdFilter(filter: IngestionStatusFilter): {
  source_id?: string
  event_slug?: string
  state?: "processed" | "rejected" | "failed"
} {
  return {
    ...(filter.sourceId ? { source_id: filter.sourceId } : {}),
    ...(filter.eventSlug ? { event_slug: filter.eventSlug } : {}),
    ...(filter.state ? { state: filter.state } : {}),
  }
}

function toTinybirdCursor(cursor: IngestionStatusCursor | null | undefined): {
  cursor_handled_at?: number
  cursor_canonical_audit_id?: string
} {
  if (!cursor) {
    return {}
  }

  return {
    cursor_handled_at: cursor.handledAt,
    cursor_canonical_audit_id: cursor.canonicalAuditId,
  }
}

function deriveTotals({
  live,
  rejections,
  recentEvents,
}: Pick<
  GetIngestionStatusOutput,
  "live" | "rejections" | "recentEvents"
>): GetIngestionStatusOutput["totals"] {
  const liveTotals = live.reduce(
    (acc, row) => ({
      processed: acc.processed + row.processed,
      rejected: acc.rejected + row.rejected,
      failed: acc.failed + row.failed,
      total: acc.total + row.total,
    }),
    { processed: 0, rejected: 0, failed: 0, total: 0 }
  )

  if (liveTotals.total > 0) {
    const accountedTotal = liveTotals.processed + liveTotals.rejected + liveTotals.failed
    if (accountedTotal >= liveTotals.total) {
      return liveTotals
    }

    return {
      ...liveTotals,
      failed: liveTotals.failed + (liveTotals.total - accountedTotal),
    }
  }

  if (recentEvents.length > 0) {
    const recentTotals = recentEvents.reduce(
      (acc, event) => ({
        processed: acc.processed + (event.state === "processed" ? 1 : 0),
        rejected: acc.rejected + (event.state === "rejected" ? 1 : 0),
        failed: acc.failed + (event.state === "failed" ? 1 : 0),
        total: acc.total + 1,
      }),
      { processed: 0, rejected: 0, failed: 0, total: 0 }
    )

    return recentTotals
  }

  const rejected = rejections.reduce((sum, row) => sum + row.eventCount, 0)
  return {
    processed: 0,
    rejected,
    failed: 0,
    total: rejected,
  }
}

function isInWindow(timestamp: number, window: GetIngestionStatusInput["window"]): boolean {
  return timestamp >= window.from && timestamp < window.to
}

function getLatestHandledAt({
  recentEvents,
  live,
  rejections,
}: Pick<GetIngestionStatusOutput, "recentEvents" | "live" | "rejections">): number | null {
  const latestRecent = maxNumber(recentEvents.map((event) => event.handledAt))
  if (latestRecent !== null) {
    return latestRecent
  }

  return maxNumber([
    ...live.flatMap((row) => {
      const second = parseTinybirdSecond(row.second)
      return second === null ? [] : [second]
    }),
    ...rejections.map((row) => row.lastSeenAt),
  ])
}

function maxNumber(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }

  return Math.max(...values)
}

function parseTinybirdSecond(second: string): number | null {
  const value = Date.parse(second.includes("T") ? second : `${second.replace(" ", "T")}Z`)
  return Number.isFinite(value) ? value : null
}

function buildEvidence({
  input,
  latestHandledAt,
  live,
  rejections,
  recentEvents,
}: {
  input: GetIngestionStatusInput
  latestHandledAt: number | null
  live: GetIngestionStatusOutput["live"]
  rejections: GetIngestionStatusOutput["rejections"]
  recentEvents: GetIngestionStatusOutput["recentEvents"]
}): GetIngestionStatusOutput["evidence"] {
  return [
    {
      type: "ingestion_status",
      id: `${input.projectId}:${input.customerId ?? "all-customers"}:${input.window.from}:${input.window.to}`,
      source: "tinybird",
      timestamp: latestHandledAt,
    },
    ...live
      .filter((row) => row.total > 0)
      .map((row) => ({
        type: "ingestion_status" as const,
        id: `live:${row.second}`,
        source: "tinybird" as const,
        timestamp: parseTinybirdSecond(row.second),
      })),
    ...rejections.map((row) => ({
      type: "ingestion_status" as const,
      id: `rejection:${row.sourceId}:${row.eventSlug}:${row.rejectionReason ?? "unknown"}:${
        row.lastSeenAt
      }`,
      source: "tinybird" as const,
      timestamp: row.lastSeenAt,
    })),
    ...recentEvents.map((event) => ({
      type: "event" as const,
      id: event.eventId,
      source: "tinybird" as const,
      timestamp: event.handledAt,
    })),
  ]
}

function buildWarnings({
  totals,
}: {
  totals: GetIngestionStatusOutput["totals"]
}): string[] {
  if (totals.total === 0) {
    return ["No ingestion events were observed in the requested window."]
  }

  if (totals.rejected > 0 || totals.failed > 0) {
    return ["Some ingestion events were rejected or failed in the requested window."]
  }

  return []
}

function buildNextActions({
  totals,
  rejections,
}: {
  totals: GetIngestionStatusOutput["totals"]
  rejections: GetIngestionStatusOutput["rejections"]
}): string[] {
  if (totals.total === 0) {
    return ["Verify the customer_id, source_id, event_slug, and time window."]
  }

  if (totals.rejected > 0 || totals.failed > 0) {
    const reasons = [...new Set(rejections.map((row) => row.rejectionReason).filter(Boolean))]
    const suffix = reasons.length > 0 ? `: ${reasons.join(", ")}` : "."

    return [`Inspect rejected or failed events and fix the reported reasons${suffix}`]
  }

  return ["No immediate action required."]
}

function buildAnswer({
  projectId,
  customerId,
  window,
  totals,
  successRate,
}: {
  projectId: string
  customerId?: string
  window: GetIngestionStatusInput["window"]
  totals: GetIngestionStatusOutput["totals"]
  successRate: number
}): string {
  const scope = customerId ? `customer ${customerId}` : `project ${projectId}`

  if (totals.total === 0) {
    return `No events were observed in the requested window for ${scope}.`
  }

  const successPercent = Math.round(successRate * 10_000) / 100

  return `${totals.total} events were observed in the requested window for ${scope} (${window.from} to ${window.to}). ${totals.processed} were processed, ${totals.rejected} were rejected, and ${totals.failed} failed, for a ${successPercent}% success rate.`
}
