import type {
  Analytics,
  IngestionFacetRow,
  IngestionLiveRow,
  IngestionRecentEventRow,
} from "@unprice/analytics"
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

const ingestionStates = ["processed", "rejected", "failed"] as const
const ingestionStateSchema = z.enum(ingestionStates)
const ingestionStatusFilterSchema = z
  .object({
    customerIds: z.array(z.string()).optional(),
    eventSlugs: z.array(z.string()).optional(),
    sourceIds: z.array(z.string()).optional(),
    sourceTypes: z.array(z.string()).optional(),
    rejectionReasons: z.array(z.string()).optional(),
    states: z.array(ingestionStateSchema).optional(),
    search: z.string().optional(),
  })
  .default({})

const ingestionFacetOptionSchema = z.object({
  value: z.string(),
  count: z.number().int().nonnegative(),
})

const ingestionStatusFacetsSchema = z.object({
  states: z.array(
    z.object({
      value: ingestionStateSchema,
      count: z.number().int().nonnegative(),
    })
  ),
  eventSlugs: z.array(ingestionFacetOptionSchema),
  sourceTypes: z.array(ingestionFacetOptionSchema),
  rejectionReasons: z.array(ingestionFacetOptionSchema),
  customers: z.array(ingestionFacetOptionSchema),
})

export const getIngestionStatusInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string().optional(),
  window: getIngestionStatusWindowSchema,
  cursor: getIngestionStatusCursorSchema.nullish(),
  filter: ingestionStatusFilterSchema,
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
  facets: ingestionStatusFacetsSchema,
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
  "getIngestionLive" | "getIngestionRejections" | "getIngestionRecent" | "getIngestionFacets"
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
      deps.analytics.getIngestionFacets({
        ...baseWindowQuery,
        ...filterQuery,
        limit: 50,
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

  const [liveResponse, rejectionsResponse, recentResponse, facetsResponse] = analyticsResult.val
  const live = (liveResponse.data ?? []).map(mapLiveRow)
  const rejections =
    hasValues(input.filter.states) && !input.filter.states.includes("rejected")
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
  const facets = mapFacetRows(facetsResponse.data ?? [])
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
    facets,
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

type FilterableIngestionRow = {
  canonical_audit_id?: string
  customer_id?: string
  event_id?: string
  event_slug?: string
  source_id?: string
  source_type?: string
  rejection_reason?: string | null
  state?: (typeof ingestionStates)[number]
}

function matchesFilter(row: FilterableIngestionRow, filter: IngestionStatusFilter): boolean {
  if (
    hasValues(filter.customerIds) &&
    row.customer_id !== undefined &&
    !filter.customerIds.includes(row.customer_id)
  ) {
    return false
  }

  if (
    hasValues(filter.eventSlugs) &&
    row.event_slug !== undefined &&
    !filter.eventSlugs.includes(row.event_slug)
  ) {
    return false
  }

  if (
    hasValues(filter.sourceIds) &&
    row.source_id !== undefined &&
    !filter.sourceIds.includes(row.source_id)
  ) {
    return false
  }

  if (
    hasValues(filter.sourceTypes) &&
    row.source_type !== undefined &&
    !filter.sourceTypes.includes(row.source_type)
  ) {
    return false
  }

  if (
    hasValues(filter.rejectionReasons) &&
    row.rejection_reason !== undefined &&
    !filter.rejectionReasons.includes(row.rejection_reason ?? "")
  ) {
    return false
  }

  if (hasValues(filter.states) && row.state && !filter.states.includes(row.state)) {
    return false
  }

  const search = filter.search?.trim().toLowerCase()
  if (!search) {
    return true
  }

  const searchableValues = [
    row.event_id,
    row.canonical_audit_id,
    row.customer_id,
    row.event_slug,
    row.source_type,
    row.source_id,
    row.rejection_reason ?? undefined,
  ].filter((value): value is string => typeof value === "string" && value.length > 0)

  if (!searchableValues.some((value) => value.toLowerCase().includes(search))) {
    return false
  }

  return true
}

function toTinybirdFilter(filter: IngestionStatusFilter): {
  filter_customer_ids?: string[]
  event_slugs?: string[]
  source_ids?: string[]
  source_types?: string[]
  rejection_reasons?: string[]
  states?: (typeof ingestionStates)[number][]
  search?: string
} {
  const customerIds = compactStringValues(filter.customerIds)
  const eventSlugs = compactStringValues(filter.eventSlugs)
  const sourceIds = compactStringValues(filter.sourceIds)
  const sourceTypes = compactStringValues(filter.sourceTypes)
  const rejectionReasons = compactStringValues(filter.rejectionReasons)
  const search = filter.search?.trim()

  return {
    ...(customerIds ? { filter_customer_ids: customerIds } : {}),
    ...(eventSlugs ? { event_slugs: eventSlugs } : {}),
    ...(sourceIds ? { source_ids: sourceIds } : {}),
    ...(sourceTypes ? { source_types: sourceTypes } : {}),
    ...(rejectionReasons ? { rejection_reasons: rejectionReasons } : {}),
    ...(hasValues(filter.states) ? { states: filter.states } : {}),
    ...(search ? { search } : {}),
  }
}

function mapFacetRows(rows: IngestionFacetRow[]): GetIngestionStatusOutput["facets"] {
  const facets: GetIngestionStatusOutput["facets"] = {
    states: [],
    eventSlugs: [],
    sourceTypes: [],
    rejectionReasons: [],
    customers: [],
  }

  for (const row of rows) {
    if (!row.value) {
      continue
    }

    const option = {
      value: row.value,
      count: row.event_count,
    }

    if (row.facet === "state") {
      if (isIngestionState(row.value)) {
        facets.states.push({
          value: row.value,
          count: row.event_count,
        })
      }
      continue
    }

    if (row.facet === "event_slug") {
      facets.eventSlugs.push(option)
      continue
    }

    if (row.facet === "source_type") {
      facets.sourceTypes.push(option)
      continue
    }

    if (row.facet === "rejection_reason") {
      facets.rejectionReasons.push(option)
      continue
    }

    if (row.facet === "customer_id") {
      facets.customers.push(option)
    }
  }

  return facets
}

function compactStringValues(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined
  }

  const compacted = Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))
  )

  return compacted.length > 0 ? compacted : undefined
}

function hasValues<T>(values: T[] | undefined): values is T[] {
  return Array.isArray(values) && values.length > 0
}

function isIngestionState(value: string): value is (typeof ingestionStates)[number] {
  return ingestionStates.includes(value as (typeof ingestionStates)[number])
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
