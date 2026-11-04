import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import { z } from "zod"
import type { AnalyticsService } from "../../analytics"
import {
  type JournalEventFilter,
  type JournalEventScope,
  customerOfKey,
} from "../../analytics/budget-journal"
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

/** The last row of a page: when the journal wrote it and its operation id. */
export const getIngestionStatusCursorSchema = z.object({
  handledAt: z.number().int(),
  canonicalAuditId: z.string(),
})

/**
 * `failed` stays in the contract for the dashboard's tones; the payer budget answers every event
 * synchronously (ADR-0008 D6), so an event that could not be decided is returned to its caller and
 * never journaled: it is always 0.
 */
const ingestionStates = ["processed", "rejected", "failed"] as const
const ingestionStateSchema = z.enum(ingestionStates)
const ingestionStatusFilterSchema = z
  .object({
    customerIds: z.array(z.string()).optional(),
    eventSlugs: z.array(z.string()).optional(),
    /** The usage verb that sent the event: `record` or `charge`. */
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
  includeFacets: z.boolean().default(false),
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
  /** Events per minute (`second` is the bucket's ISO start), oldest first. */
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
      /** The usage verb, as for `sourceType`. */
      sourceId: z.string(),
      sourceType: z.string(),
      eventCount: z.number().int(),
      lastSeenAt: z.number().int(),
    })
  ),
  recentEvents: z.array(
    z.object({
      /** The event's idempotency key. */
      eventId: z.string(),
      /** The journal's operation id: `o:<key hash>`, or `r:<idempotency key>` for a refusal. */
      canonicalAuditId: z.string(),
      customerId: z.string(),
      eventSlug: z.string(),
      sourceType: z.string(),
      /** The payer budget key. */
      sourceId: z.string(),
      ingestionMode: z.enum(["async", "sync", "run"]).nullable(),
      runId: z.string().nullable(),
      traceId: z.string().nullable(),
      parentRunId: z.string().nullable(),
      workloadType: z.enum(["agent", "workflow", "job", "tool", "custom"]).nullable(),
      workloadId: z.string().nullable(),
      state: ingestionStateSchema,
      rejectionReason: z.string().nullable(),
      failureStage: z.string().nullable(),
      failureReason: z.string().nullable(),
      failureMessage: z.string().nullable(),
      replayable: z.boolean(),
      /** When the event happened; when it was journaled if it carried no time. */
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
type Output = GetIngestionStatusOutput

export type GetIngestionStatusDeps = {
  analytics: Pick<
    AnalyticsService,
    "getEventTotals" | "getEventTimeline" | "getRejections" | "getRecentEvents" | "getEventFacets"
  >
  now?: () => number
}

const FACET_LIMIT = 50

/**
 * What happened to the usage events sent to the project's payer budgets in a window, read from the
 * budget journal (ADR-0008 D7): each accepted record or charge, and each refused event the API
 * journaled with its rejection. The journal lags the budget by its export, a few minutes.
 */
export async function getIngestionStatus(
  deps: GetIngestionStatusDeps,
  rawInput: GetIngestionStatusInput
): Promise<Result<GetIngestionStatusOutput, FetchError>> {
  const input = getIngestionStatusInputSchema.parse(rawInput)
  const scope: JournalEventScope = {
    projectId: input.projectId,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    window: { from: new Date(input.window.from), to: new Date(input.window.to) },
    filter: journalFilter(input.filter),
  }
  const failedOnly = input.filter.states?.length === 1 && input.filter.states[0] === "failed"

  const [totals, timeline, rejections, recent, facets] = await Promise.all([
    deps.analytics.getEventTotals(scope),
    deps.analytics.getEventTimeline(scope),
    deps.analytics.getRejections({ ...scope, limit: input.limit }),
    deps.analytics.getRecentEvents({
      ...scope,
      limit: input.limit + 1,
      cursor: input.cursor
        ? { handledAt: input.cursor.handledAt, operationId: input.cursor.canonicalAuditId }
        : null,
    }),
    input.includeFacets
      ? deps.analytics.getEventFacets({ ...scope, limit: FACET_LIMIT })
      : Promise.resolve(Ok([])),
  ])
  for (const result of [totals, timeline, rejections, recent, facets]) {
    if (result.err) return Err(result.err)
  }
  if (!totals.val || !timeline.val || !rejections.val || !recent.val || !facets.val) {
    throw new Error("unreachable: every journal read succeeded")
  }

  const counts = { processed: 0, rejected: 0 }
  let latestHandledAt: number | null = null
  for (const row of failedOnly ? [] : totals.val) {
    counts[row.state] += row.events
    const seen = row.last_seen_at?.getTime() ?? null
    if (seen !== null && (latestHandledAt === null || seen > latestHandledAt)) {
      latestHandledAt = seen
    }
  }
  const total = counts.processed + counts.rejected
  const outputTotals = { ...counts, failed: 0, total }
  const successRate = total === 0 ? 0 : counts.processed / total

  const recentRows = failedOnly ? [] : recent.val
  const recentEvents = recentRows
    .slice(0, input.limit)
    .map((row): Output["recentEvents"][number] => ({
      eventId: row.idempotency_key ?? row.operation_id,
      canonicalAuditId: row.operation_id,
      customerId: customerOfKey(row.budget_key) ?? row.budget_key,
      eventSlug: row.event_slug ?? "",
      sourceType: row.kind,
      sourceId: row.budget_key,
      ingestionMode: null,
      runId: null,
      traceId: null,
      parentRunId: null,
      workloadType: null,
      workloadId: null,
      state: row.state,
      rejectionReason: row.rejection_reason,
      failureStage: null,
      failureReason: null,
      failureMessage: null,
      replayable: false,
      timestamp: row.occurred_at ?? row.timestamp.getTime(),
      receivedAt: row.timestamp.getTime(),
      handledAt: row.timestamp.getTime(),
    }))
  const lastVisible = recentRows.length > input.limit ? recentRows[input.limit - 1] : undefined
  const nextCursor = lastVisible
    ? { handledAt: lastVisible.timestamp.getTime(), canonicalAuditId: lastVisible.operation_id }
    : null

  const live = foldTimeline(failedOnly ? [] : timeline.val)
  const outputRejections = (failedOnly ? [] : rejections.val).map((row) => ({
    rejectionReason: row.rejection_reason,
    eventSlug: row.event_slug ?? "",
    sourceId: row.kind,
    sourceType: row.kind,
    eventCount: row.events,
    lastSeenAt: row.last_seen_at.getTime(),
  }))

  const now = deps.now?.() ?? Date.now()
  const output: GetIngestionStatusOutput = {
    window: input.window,
    totals: outputTotals,
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
    rejections: outputRejections,
    recentEvents,
    facets: foldFacets(facets.val, outputTotals),
    nextCursor,
    answer: buildAnswer({
      projectId: input.projectId,
      customerId: input.customerId,
      window: input.window,
      totals: outputTotals,
      successRate,
    }),
    confidence: total > 0 ? "high" : "low",
    evidence: buildEvidence({ input, latestHandledAt, rejections: outputRejections, recentEvents }),
    warnings: buildWarnings(outputTotals),
    nextActions: buildNextActions(outputTotals, outputRejections),
  }

  return Ok(getIngestionStatusOutputSchema.parse(output))
}

function journalFilter(filter: GetIngestionStatusInput["filter"]): JournalEventFilter {
  const states = (filter.states ?? []).filter(
    (state): state is "processed" | "rejected" => state !== "failed"
  )
  return {
    ...(compact(filter.customerIds) && { customerIds: compact(filter.customerIds) }),
    ...(compact(filter.eventSlugs) && { eventSlugs: compact(filter.eventSlugs) }),
    ...(compact(filter.sourceTypes) && { kinds: compact(filter.sourceTypes) }),
    ...(compact(filter.rejectionReasons) && {
      rejectionReasons: compact(filter.rejectionReasons),
    }),
    ...(states.length > 0 && { states }),
    ...(filter.search?.trim() && { search: filter.search.trim() }),
  }
}

function compact(values: string[] | undefined): string[] | undefined {
  const unique = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
  return unique.length > 0 ? unique : undefined
}

function foldTimeline(
  rows: readonly { bucket: Date; state: "processed" | "rejected"; events: number }[]
): Output["live"] {
  const byBucket = new Map<number, Output["live"][number]>()
  for (const row of rows) {
    const at = row.bucket.getTime()
    const entry = byBucket.get(at) ?? {
      second: row.bucket.toISOString(),
      processed: 0,
      rejected: 0,
      failed: 0,
      total: 0,
    }
    entry[row.state] += row.events
    entry.total += row.events
    byBucket.set(at, entry)
  }
  return [...byBucket.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry)
}

function foldFacets(
  rows: readonly {
    facet: "event_slug" | "rejection_reason" | "budget_key"
    value: string
    events: number
  }[],
  totals: Output["totals"]
): Output["facets"] {
  const facets: Output["facets"] = {
    states: (["processed", "rejected"] as const)
      .filter((state) => totals[state] > 0)
      .map((state) => ({ value: state, count: totals[state] })),
    eventSlugs: [],
    sourceTypes: [],
    rejectionReasons: [],
    customers: [],
  }
  for (const row of rows) {
    const option = { value: row.value, count: row.events }
    if (row.facet === "event_slug") facets.eventSlugs.push(option)
    if (row.facet === "rejection_reason") facets.rejectionReasons.push(option)
    if (row.facet === "budget_key") {
      const customerId = customerOfKey(row.value)
      if (customerId) facets.customers.push({ ...option, value: customerId })
    }
  }
  return facets
}

function buildEvidence({
  input,
  latestHandledAt,
  rejections,
  recentEvents,
}: {
  input: GetIngestionStatusInput
  latestHandledAt: number | null
  rejections: Output["rejections"]
  recentEvents: Output["recentEvents"]
}): Output["evidence"] {
  return [
    {
      type: "ingestion_status",
      id: `${input.projectId}:${input.customerId ?? "all-customers"}:${input.window.from}:${input.window.to}`,
      source: "r2",
      timestamp: latestHandledAt,
    },
    ...rejections.map((row) => ({
      type: "ingestion_status" as const,
      id: `rejection:${row.sourceType}:${row.eventSlug}:${row.rejectionReason ?? "unknown"}:${row.lastSeenAt}`,
      source: "r2" as const,
      timestamp: row.lastSeenAt,
    })),
    ...recentEvents.map((event) => ({
      type: "event" as const,
      id: event.eventId,
      source: "r2" as const,
      timestamp: event.handledAt,
    })),
  ]
}

function buildWarnings(totals: Output["totals"]): string[] {
  if (totals.total === 0) {
    return ["No usage events were journaled in the requested window."]
  }
  if (totals.rejected > 0) {
    return ["Some usage events were rejected in the requested window."]
  }
  return []
}

function buildNextActions(totals: Output["totals"], rejections: Output["rejections"]): string[] {
  if (totals.total === 0) {
    return [
      "Verify the customer_id, event_slug, and time window; the journal lags the budget by a few minutes.",
    ]
  }
  if (totals.rejected > 0) {
    const reasons = [...new Set(rejections.map((row) => row.rejectionReason).filter(Boolean))]
    const suffix = reasons.length > 0 ? `: ${reasons.join(", ")}` : "."
    return [`Inspect rejected events and fix the reported reasons${suffix}`]
  }
  return []
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
  totals: Output["totals"]
  successRate: number
}): string {
  const scope = customerId ? `customer ${customerId}` : `project ${projectId}`
  if (totals.total === 0) {
    return `No events were observed in the requested window for ${scope}.`
  }
  const successPercent = Math.round(successRate * 10_000) / 100
  return `${totals.total} events were observed in the requested window for ${scope} (${window.from} to ${window.to}). ${totals.processed} were processed and ${totals.rejected} were rejected, for a ${successPercent}% success rate.`
}
