import type {
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
          total: 3,
        },
      ],
    })

    const result = await getIngestionStatus(deps, baseInput())

    expect(result.err).toBeUndefined()
    expect(result.val?.totals).toEqual({
      processed: 2,
      rejected: 1,
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
          total: 2,
        },
      ],
      rejectionRows: [
        rejectionRow({ source_id: "src_1", event_slug: "usage.recorded", event_count: 1 }),
        rejectionRow({ source_id: "src_2", event_slug: "usage.recorded", event_count: 5 }),
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
          event_slug: "usage.recorded",
          handled_at: fromTs + 5_000,
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
        sourceId: "src_1",
        eventSlug: "usage.recorded",
      },
      limit: 5,
    })

    expect(result.err).toBeUndefined()
    expect(analytics.getIngestionLive).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      from_ts: fromTs,
      to_ts: toTs,
      source_id: "src_1",
      event_slug: "usage.recorded",
    })
    expect(analytics.getIngestionRejections).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      from_ts: fromTs,
      to_ts: toTs,
      source_id: "src_1",
      event_slug: "usage.recorded",
      limit: 5,
    })
    expect(analytics.getIngestionRecent).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      from_ts: fromTs,
      to_ts: toTs,
      source_id: "src_1",
      event_slug: "usage.recorded",
      limit: 5,
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
    timestamp: fromTs + 1_000,
    received_at: fromTs + 1_100,
    handled_at: fromTs + 1_200,
    ...overrides,
  }
}
