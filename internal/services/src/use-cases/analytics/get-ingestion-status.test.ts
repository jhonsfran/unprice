import { FetchError } from "@unprice/error"
import { describe, expect, it } from "vitest"
import { ZodError } from "zod"
import { journalAnalytics } from "../../analytics/journal.fixture"
import { type GetIngestionStatusInput, getIngestionStatus } from "./get-ingestion-status"

const from = Date.parse("2026-11-03T09:00:00.000Z")
const to = Date.parse("2026-11-03T10:00:00.000Z")
const now = Date.parse("2026-11-03T10:00:30.000Z")

/** Literal Basin rows per query, told apart by the SELECT each builder ends with. */
function answer(rows: {
  totals?: unknown[]
  timeline?: unknown[]
  rejections?: unknown[]
  recent?: unknown[]
  facets?: unknown[]
}) {
  return (sql: string) => {
    if (sql.includes("SELECT state, COUNT(*)")) return rows.totals ?? []
    if (sql.includes("date_trunc('minute'")) return rows.timeline ?? []
    if (sql.includes("SELECT rejection_reason")) return rows.rejections ?? []
    if (sql.includes("facets AS")) return rows.facets ?? []
    if (sql.includes("SELECT budget_key, operation_id, kind, state")) return rows.recent ?? []
    throw new Error(`unexpected query: ${sql}`)
  }
}

const accepted = {
  budget_key: "unprice:customer:cus_1",
  operation_id: "o:hash_2",
  kind: "record",
  state: "processed",
  timestamp: "2026-11-03T09:40:00.000Z",
  event_slug: "tokens",
  idempotency_key: "evt_2",
  rejection_reason: null,
  occurred_at: Date.parse("2026-11-03T09:39:00.000Z"),
}

const refused = {
  budget_key: "unprice:customer:cus_1",
  operation_id: "r:evt_1",
  kind: "charge",
  state: "rejected",
  timestamp: "2026-11-03T09:30:00.000Z",
  event_slug: "tokens",
  idempotency_key: "evt_1",
  rejection_reason: "LIMIT_EXCEEDED",
  occurred_at: null,
}

describe("getIngestionStatus", () => {
  it("rejects invalid windows before reading the journal", async () => {
    const { analytics, queries } = journalAnalytics(answer({}))
    await expect(
      getIngestionStatus({ analytics }, { ...input(), window: { from: to, to: from } })
    ).rejects.toBeInstanceOf(ZodError)
    expect(queries).toEqual([])
  })

  it("reads totals, timeline, rejections, events, and facets from the journal", async () => {
    const { analytics, queries } = journalAnalytics(
      answer({
        totals: [
          { state: "processed", events: "3", last_seen_at: "2026-11-03T09:40:00.000Z" },
          { state: "rejected", events: 1, last_seen_at: "2026-11-03T09:30:00.000Z" },
        ],
        timeline: [
          { bucket: "2026-11-03T09:40:00.000Z", state: "processed", events: 3 },
          { bucket: "2026-11-03T09:30:00.000Z", state: "rejected", events: 1 },
        ],
        rejections: [
          {
            rejection_reason: "LIMIT_EXCEEDED",
            event_slug: "tokens",
            kind: "charge",
            events: 1,
            last_seen_at: "2026-11-03T09:30:00.000Z",
          },
        ],
        recent: [accepted, refused],
        facets: [
          { facet: "event_slug", value: "tokens", events: 4 },
          { facet: "budget_key", value: "unprice:customer:cus_1", events: 4 },
          { facet: "rejection_reason", value: "LIMIT_EXCEEDED", events: 1 },
        ],
      })
    )

    const result = await getIngestionStatus(
      { analytics, now: () => now },
      input({ includeFacets: true, filter: { sourceTypes: ["charge"], states: ["rejected"] } })
    )

    expect(queries).toHaveLength(5)
    for (const sql of queries) {
      expect(sql).toContain("WHERE project_id = 'proj_1'")
      expect(sql).toContain("QUALIFY ROW_NUMBER() OVER (PARTITION BY budget_key, operation_id")
      expect(sql).toContain("kind IN ('charge')")
      expect(sql).toContain("state IN ('rejected')")
    }
    expect(result.val?.totals).toEqual({ processed: 3, rejected: 1, failed: 0, total: 4 })
    expect(result.val?.successRate).toBe(0.75)
    expect(result.val?.freshness).toEqual({
      generatedAt: now,
      dataFrom: from,
      dataTo: Date.parse("2026-11-03T09:40:00.000Z"),
      latestHandledAt: Date.parse("2026-11-03T09:40:00.000Z"),
      secondsSinceLatest: 1230,
    })
    expect(result.val?.live.map((row) => [row.second, row.total])).toEqual([
      ["2026-11-03T09:30:00.000Z", 1],
      ["2026-11-03T09:40:00.000Z", 3],
    ])
    expect(result.val?.rejections).toEqual([
      {
        rejectionReason: "LIMIT_EXCEEDED",
        eventSlug: "tokens",
        sourceId: "charge",
        sourceType: "charge",
        eventCount: 1,
        lastSeenAt: Date.parse("2026-11-03T09:30:00.000Z"),
      },
    ])
    expect(result.val?.recentEvents[1]).toMatchObject({
      eventId: "evt_1",
      canonicalAuditId: "r:evt_1",
      customerId: "cus_1",
      state: "rejected",
      rejectionReason: "LIMIT_EXCEEDED",
      sourceType: "charge",
      replayable: false,
      timestamp: Date.parse("2026-11-03T09:30:00.000Z"),
    })
    expect(result.val?.recentEvents[0]?.timestamp).toBe(accepted.occurred_at)
    expect(result.val?.facets).toEqual({
      states: [
        { value: "processed", count: 3 },
        { value: "rejected", count: 1 },
      ],
      eventSlugs: [{ value: "tokens", count: 4 }],
      sourceTypes: [],
      rejectionReasons: [{ value: "LIMIT_EXCEEDED", count: 1 }],
      customers: [{ value: "cus_1", count: 4 }],
    })
    expect(result.val?.nextCursor).toBeNull()
  })

  it("pages with the last visible row as the cursor", async () => {
    const { analytics, queries } = journalAnalytics(answer({ recent: [accepted, refused] }))
    const result = await getIngestionStatus(
      { analytics, now: () => now },
      input({ limit: 1, cursor: { handledAt: to, canonicalAuditId: "o:z" } })
    )
    expect(queries.find((sql) => sql.endsWith("LIMIT 2"))).toContain(
      "(timestamp < '2026-11-03T10:00:00.000Z' OR (timestamp = '2026-11-03T10:00:00.000Z' AND operation_id < 'o:z'))"
    )
    expect(result.val?.recentEvents).toHaveLength(1)
    expect(result.val?.nextCursor).toEqual({
      handledAt: Date.parse("2026-11-03T09:40:00.000Z"),
      canonicalAuditId: "o:hash_2",
    })
  })

  it("answers nothing for a failed-only filter: no event fails in the journal", async () => {
    const { analytics } = journalAnalytics(
      answer({ totals: [{ state: "processed", events: 2, last_seen_at: null }] })
    )
    const result = await getIngestionStatus(
      { analytics, now: () => now },
      input({ filter: { states: ["failed"] } })
    )
    expect(result.val?.totals).toEqual({ processed: 0, rejected: 0, failed: 0, total: 0 })
    expect(result.val?.confidence).toBe("low")
  })

  it("returns a journal failure as a fetch error", async () => {
    const { analytics } = journalAnalytics(() => new Error("basin down"))
    const result = await getIngestionStatus({ analytics, now: () => now }, input())
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toContain("basin down")
  })
})

function input(overrides: Partial<GetIngestionStatusInput> = {}): GetIngestionStatusInput {
  return {
    projectId: "proj_1",
    window: { from, to },
    filter: {},
    includeFacets: false,
    limit: 50,
    ...overrides,
  }
}
