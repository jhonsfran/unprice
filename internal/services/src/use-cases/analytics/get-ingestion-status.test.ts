import type {
  IngestionFacetRow,
  IngestionLiveRow,
  IngestionRecentEventRow,
  IngestionRejectionRow,
} from "@unprice/analytics"
import { FetchError } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { ZodError } from "zod"
import {
  type GetIngestionStatusDeps,
  type GetIngestionStatusInput,
  getIngestionStatus,
} from "./get-ingestion-status"

const fromTs = 4_070_908_800_000
const toTs = 4_070_995_200_000
const now = 4_070_908_809_000

describe("getIngestionStatus", () => {
  it("rejects invalid windows before calling Tinybird", async () => {
    const { deps, analytics } = makeDeps()

    await expect(
      getIngestionStatus(deps, {
        ...baseInput(),
        window: {
          from: toTs,
          to: fromTs,
        },
      })
    ).rejects.toBeInstanceOf(ZodError)

    expect(analytics.getIngestionLive).not.toHaveBeenCalled()
    expect(analytics.getIngestionRejections).not.toHaveBeenCalled()
    expect(analytics.getIngestionRecent).not.toHaveBeenCalled()
    expect(analytics.getIngestionFacets).not.toHaveBeenCalled()
  })

  it("returns Tinybird failures as fetch errors", async () => {
    const { deps } = makeDeps({
      liveError: new Error("tinybird unavailable"),
    })

    const result = await getIngestionStatus(deps, baseInput())

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toBe("tinybird unavailable")
  })

  it("uses live rows for totals and freshness when recent rows are unavailable", async () => {
    const { deps } = makeDeps({
      now: () => 4_070_908_806_500,
      liveRows: [
        {
          second: "2099-01-01 00:00:03.000",
          processed: 2,
          rejected: 1,
          failed: 0,
          total: 3,
        },
      ],
    })

    const result = await getIngestionStatus(deps, baseInput())

    expect(result.err).toBeUndefined()
    expect(result.val?.totals).toEqual({
      processed: 2,
      rejected: 1,
      failed: 0,
      total: 3,
    })
    expect(result.val?.successRate).toBe(2 / 3)
    expect(result.val?.freshness).toEqual({
      generatedAt: 4_070_908_806_500,
      dataFrom: fromTs,
      dataTo: fromTs + 3_000,
      latestHandledAt: fromTs + 3_000,
      secondsSinceLatest: 3,
    })
  })

  it("infers failed totals when live rows use an older shape without failed counts", async () => {
    const { deps } = makeDeps({
      liveRows: [
        {
          second: "2099-01-01 00:00:03.000",
          processed: 0,
          rejected: 0,
          failed: 0,
          total: 11,
        },
      ],
    })

    const result = await getIngestionStatus(deps, baseInput())

    expect(result.err).toBeUndefined()
    expect(result.val?.totals).toEqual({
      processed: 0,
      rejected: 0,
      failed: 11,
      total: 11,
    })
  })

  it("uses rejection rows for fallback totals and freshness when live/recent rows are unavailable", async () => {
    const { deps } = makeDeps({
      now: () => fromTs + 8_000,
      rejectionRows: [
        rejectionRow({
          event_count: 2,
          last_seen_at: fromTs + 5_000,
        }),
      ],
    })

    const result = await getIngestionStatus(deps, baseInput())

    expect(result.err).toBeUndefined()
    expect(result.val?.totals).toEqual({
      processed: 0,
      rejected: 2,
      failed: 0,
      total: 2,
    })
    expect(result.val?.freshness).toEqual({
      generatedAt: fromTs + 8_000,
      dataFrom: fromTs,
      dataTo: fromTs + 5_000,
      latestHandledAt: fromTs + 5_000,
      secondsSinceLatest: 3,
    })
    expect(result.val?.answer).toContain("2 events were observed")
  })

  it("passes filters to Tinybird and filters mixed rows defensively", async () => {
    const { deps, analytics } = makeDeps({
      now: () => fromTs + 9_000,
      liveRows: [
        {
          second: "2099-01-01 00:00:04.000",
          processed: 1,
          rejected: 1,
          failed: 0,
          total: 2,
        },
      ],
      rejectionRows: [
        rejectionRow({ source_id: "src_1", event_slug: "usage.recorded", event_count: 1 }),
        rejectionRow({
          source_id: "src_2",
          source_type: "system",
          event_slug: "usage.recorded",
          event_count: 5,
        }),
        rejectionRow({
          source_id: "src_3",
          source_type: "api_key",
          event_slug: "usage.recorded",
          event_count: 8,
        }),
        rejectionRow({ source_id: "src_1", event_slug: "other.event", event_count: 7 }),
      ],
      recentRows: [
        recentEvent({
          event_id: "evt_match",
          source_id: "src_1",
          event_slug: "usage.recorded",
          handled_at: fromTs + 4_000,
        }),
        recentEvent({
          event_id: "evt_wrong_source",
          source_id: "src_2",
          source_type: "system",
          event_slug: "usage.recorded",
          handled_at: fromTs + 5_000,
        }),
        recentEvent({
          event_id: "evt_wrong_source_id",
          source_id: "src_3",
          event_slug: "usage.recorded",
          handled_at: fromTs + 5_500,
        }),
        recentEvent({
          event_id: "evt_wrong_slug",
          source_id: "src_1",
          event_slug: "other.event",
          handled_at: fromTs + 6_000,
        }),
      ],
    })

    const result = await getIngestionStatus(deps, {
      ...baseInput(),
      filter: {
        eventSlugs: ["usage.recorded"],
        sourceIds: ["src_1"],
        sourceTypes: ["api_key"],
      },
      limit: 5,
    })

    expect(result.err).toBeUndefined()
    expect(analytics.getIngestionLive).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      from_ts: fromTs,
      to_ts: toTs,
      event_slugs: ["usage.recorded"],
      source_ids: ["src_1"],
      source_types: ["api_key"],
    })
    expect(analytics.getIngestionRejections).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      from_ts: fromTs,
      to_ts: toTs,
      event_slugs: ["usage.recorded"],
      source_ids: ["src_1"],
      source_types: ["api_key"],
      limit: 5,
    })
    expect(analytics.getIngestionRecent).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      from_ts: fromTs,
      to_ts: toTs,
      event_slugs: ["usage.recorded"],
      source_ids: ["src_1"],
      source_types: ["api_key"],
      limit: 6,
    })
    expect(analytics.getIngestionFacets).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      from_ts: fromTs,
      to_ts: toTs,
      event_slugs: ["usage.recorded"],
      source_ids: ["src_1"],
      source_types: ["api_key"],
      limit: 50,
    })
    expect(result.val?.rejections).toEqual([
      {
        rejectionReason: "missing_required_property",
        eventSlug: "usage.recorded",
        sourceId: "src_1",
        sourceType: "api_key",
        eventCount: 1,
        lastSeenAt: fromTs + 2_200,
      },
    ])
    expect(result.val?.recentEvents.map((event) => event.eventId)).toEqual(["evt_match"])
    expect(result.val?.freshness).toEqual({
      generatedAt: fromTs + 9_000,
      dataFrom: fromTs,
      dataTo: fromTs + 4_000,
      latestHandledAt: fromTs + 4_000,
      secondsSinceLatest: 5,
    })
  })

  it("queries project-wide ingestion status when customerId is omitted", async () => {
    const { deps, analytics } = makeDeps({
      now: () => fromTs + 9_000,
      liveRows: [
        {
          second: "2099-01-01 00:00:04.000",
          processed: 1,
          rejected: 0,
          failed: 0,
          total: 1,
        },
      ],
      recentRows: [
        recentEvent({
          event_id: "evt_project",
          customer_id: "cus_2",
          handled_at: fromTs + 4_000,
        }),
      ],
    })

    const result = await getIngestionStatus(deps, {
      ...baseInput(),
      customerId: undefined,
      filter: {
        states: ["processed"],
      },
    })

    expect(result.err).toBeUndefined()
    expect(analytics.getIngestionLive).toHaveBeenCalledWith({
      project_id: "proj_1",
      from_ts: fromTs,
      to_ts: toTs,
      states: ["processed"],
    })
    expect(analytics.getIngestionRecent).toHaveBeenCalledWith({
      project_id: "proj_1",
      from_ts: fromTs,
      to_ts: toTs,
      states: ["processed"],
      limit: 51,
    })
    expect(result.val?.recentEvents).toEqual([
      expect.objectContaining({
        eventId: "evt_project",
        customerId: "cus_2",
        state: "processed",
      }),
    ])
    expect(result.val?.answer).toContain("project proj_1")
  })

  it("returns full-window facets separately from paginated recent events", async () => {
    const { deps } = makeDeps({
      recentRows: [
        recentEvent({
          event_id: "evt_page_1",
          customer_id: "cus_page",
          event_slug: "page.only",
          handled_at: fromTs + 4_000,
        }),
      ],
      facetRows: [
        facetRow({ facet: "state", value: "processed", event_count: 20 }),
        facetRow({ facet: "state", value: "rejected", event_count: 3 }),
        facetRow({ facet: "event_slug", value: "usage.recorded", event_count: 18 }),
        facetRow({ facet: "source_type", value: "api_key", event_count: 18 }),
        facetRow({ facet: "rejection_reason", value: "RUN_BUDGET_EXCEEDED", event_count: 3 }),
        facetRow({ facet: "customer_id", value: "cus_full_window", event_count: 12 }),
      ],
    })

    const result = await getIngestionStatus(deps, baseInput({ limit: 1 }))

    expect(result.err).toBeUndefined()
    expect(result.val?.recentEvents.map((event) => event.eventSlug)).toEqual(["page.only"])
    expect(result.val?.facets).toEqual({
      states: [
        { value: "processed", count: 20 },
        { value: "rejected", count: 3 },
      ],
      eventSlugs: [{ value: "usage.recorded", count: 18 }],
      sourceTypes: [{ value: "api_key", count: 18 }],
      rejectionReasons: [{ value: "RUN_BUDGET_EXCEEDED", count: 3 }],
      customers: [{ value: "cus_full_window", count: 12 }],
    })
  })

  it("returns a composite cursor and passes it to Tinybird for the next page", async () => {
    const { deps, analytics } = makeDeps({
      recentRows: [
        recentEvent({
          event_id: "evt_1",
          canonical_audit_id: "audit_c",
          handled_at: fromTs + 3_000,
        }),
        recentEvent({
          event_id: "evt_2",
          canonical_audit_id: "audit_b",
          handled_at: fromTs + 2_000,
        }),
        recentEvent({
          event_id: "evt_3",
          canonical_audit_id: "audit_a",
          handled_at: fromTs + 1_000,
        }),
      ],
    })

    const result = await getIngestionStatus(deps, {
      ...baseInput(),
      cursor: {
        handledAt: fromTs + 4_000,
        canonicalAuditId: "audit_cursor",
      },
      limit: 2,
    })

    expect(result.err).toBeUndefined()
    expect(analytics.getIngestionRecent).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      from_ts: fromTs,
      to_ts: toTs,
      cursor_handled_at: fromTs + 4_000,
      cursor_canonical_audit_id: "audit_cursor",
      limit: 3,
    })
    expect(result.val?.recentEvents.map((event) => event.eventId)).toEqual(["evt_1", "evt_2"])
    expect(result.val?.nextCursor).toEqual({
      handledAt: fromTs + 2_000,
      canonicalAuditId: "audit_b",
    })
  })
})

function baseInput(overrides: Partial<GetIngestionStatusInput> = {}): GetIngestionStatusInput {
  return {
    projectId: "proj_1",
    customerId: "cus_1",
    window: {
      from: fromTs,
      to: toTs,
    },
    filter: {},
    limit: 50,
    ...overrides,
  }
}

function makeDeps(
  options: {
    now?: () => number
    liveRows?: IngestionLiveRow[]
    rejectionRows?: IngestionRejectionRow[]
    recentRows?: IngestionRecentEventRow[]
    facetRows?: IngestionFacetRow[]
    liveError?: Error
  } = {}
): { deps: GetIngestionStatusDeps; analytics: GetIngestionStatusDeps["analytics"] } {
  const analytics = {
    getIngestionLive: vi.fn(() => {
      if (options.liveError) {
        return Promise.reject(options.liveError)
      }

      return Promise.resolve({ data: options.liveRows ?? [] })
    }),
    getIngestionRejections: vi.fn(() => Promise.resolve({ data: options.rejectionRows ?? [] })),
    getIngestionRecent: vi.fn(() => Promise.resolve({ data: options.recentRows ?? [] })),
    getIngestionFacets: vi.fn(() => Promise.resolve({ data: options.facetRows ?? [] })),
  } as unknown as GetIngestionStatusDeps["analytics"]

  return {
    deps: {
      analytics,
      now: options.now ?? (() => now),
    },
    analytics,
  }
}

function rejectionRow(overrides: Partial<IngestionRejectionRow> = {}): IngestionRejectionRow {
  return {
    rejection_reason: "missing_required_property",
    event_slug: "usage.recorded",
    source_id: "src_1",
    source_type: "api_key",
    event_count: 1,
    last_seen_at: fromTs + 2_200,
    ...overrides,
  }
}

function facetRow(overrides: Partial<IngestionFacetRow> = {}): IngestionFacetRow {
  return {
    facet: "state",
    value: "processed",
    event_count: 1,
    ...overrides,
  }
}

function recentEvent(overrides: Partial<IngestionRecentEventRow> = {}): IngestionRecentEventRow {
  return {
    event_id: "evt_1",
    canonical_audit_id: "audit_1",
    customer_id: "cus_1",
    event_slug: "usage.recorded",
    source_type: "api_key",
    source_id: "src_1",
    state: "processed",
    rejection_reason: null,
    failure_stage: null,
    failure_reason: null,
    failure_message: null,
    replayable: false,
    timestamp: fromTs + 1_000,
    received_at: fromTs + 1_100,
    handled_at: fromTs + 1_200,
    ...overrides,
  }
}
