import type { Database } from "@unprice/db"
import { Err, Ok } from "@unprice/error"
import { type BasinSql, BasinSqlError } from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { AnalyticsService } from "./service"

const now = Date.UTC(2026, 10, 3, 10, 30)

function createLogger(): Logger {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

/** A Basin SQL port that answers every query with fixed rows, parsed by the caller's row schema. */
function fakeBasinSql(rows: unknown[]) {
  const queries: string[] = []
  const basinSql: BasinSql = {
    async query(sql, row) {
      queries.push(sql)
      return Ok(z.array(row).parse(rows))
    },
  }
  return { basinSql, queries }
}

function createService(basinSql: BasinSql) {
  const db = {
    query: { pages: { findFirst: vi.fn().mockResolvedValue({ id: "page_1" }) } },
  } as unknown as Database
  return new AnalyticsService({
    db,
    logger: createLogger(),
    basinSql,
    ledgerGateway: {} as never,
  })
}

function zeroDay(date: string) {
  return {
    date: new Date(date),
    page_id: "page_1",
    desktop_visits: 0,
    mobile_visits: 0,
    other_visits: 0,
    desktop_hits: 0,
    mobile_hits: 0,
    other_hits: 0,
    total_visits: 0,
    total_hits: 0,
  }
}

describe("AnalyticsService web analytics reads", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns country visits in the dashboard shape", async () => {
    const { basinSql, queries } = fakeBasinSql([
      { page_id: "page_1", country: "DE", visits: 12, hits: 30 },
      { page_id: "page_1", country: null, visits: "3", hits: "4" },
    ])

    const result = await createService(basinSql).getCountryVisits({
      projectId: "proj_1",
      pageId: "page_1",
      intervalDays: 7,
    })

    expect(result).toEqual({
      val: {
        data: [
          { page_id: "page_1", country: "DE", visits: 12, hits: 30 },
          { page_id: "page_1", country: "Unknown", visits: 3, hits: 4 },
        ],
      },
    })
    expect(queries).toHaveLength(1)
  })

  it("returns browser visits in the dashboard shape", async () => {
    const { basinSql } = fakeBasinSql([
      { page_id: "page_1", browser: "Chrome", visits: 5, hits: 9 },
    ])

    const result = await createService(basinSql).getBrowserVisits({
      projectId: "proj_1",
      pageId: "page_1",
      intervalDays: 7,
    })

    expect(result).toEqual({
      val: { data: [{ page_id: "page_1", browser: "Chrome", visits: 5, hits: 9 }] },
    })
  })

  it("folds device rows into one row per day and fills empty days", async () => {
    const { basinSql } = fakeBasinSql([
      { bucket: "2026-11-02T00:00:00Z", page_id: "page_1", device: "desktop", visits: 3, hits: 5 },
      { bucket: "2026-11-02T00:00:00Z", page_id: "page_1", device: "Mobile", visits: 2, hits: 2 },
      { bucket: "2026-11-02T00:00:00Z", page_id: "page_1", device: "tablet", visits: 1, hits: 1 },
      { bucket: "2026-11-02T00:00:00Z", page_id: "page_1", device: "smarttv", visits: 1, hits: 4 },
    ])

    const result = await createService(basinSql).getPagesOverview({
      projectId: "proj_1",
      pageId: "page_1",
      intervalDays: 7,
    })

    expect(result).toEqual({
      val: {
        data: [
          zeroDay("2026-10-27T00:00:00.000Z"),
          zeroDay("2026-10-28T00:00:00.000Z"),
          zeroDay("2026-10-29T00:00:00.000Z"),
          zeroDay("2026-10-30T00:00:00.000Z"),
          zeroDay("2026-10-31T00:00:00.000Z"),
          zeroDay("2026-11-01T00:00:00.000Z"),
          {
            date: new Date("2026-11-02T00:00:00.000Z"),
            page_id: "page_1",
            desktop_visits: 3,
            mobile_visits: 2,
            other_visits: 1,
            desktop_hits: 5,
            mobile_hits: 2,
            other_hits: 4,
            total_visits: 7,
            total_hits: 12,
          },
          zeroDay("2026-11-03T00:00:00.000Z"),
        ],
      },
    })
  })

  it("keeps viewed plan versions, computes conversion, and sorts by it", async () => {
    const { basinSql } = fakeBasinSql([
      {
        plan_version_id: "pv_1",
        page_id: "page_1",
        plan_views: 10,
        plan_clicks: 4,
        plan_signups: 2,
      },
      {
        plan_version_id: "pv_2",
        page_id: "page_1",
        plan_views: 0,
        plan_clicks: 1,
        plan_signups: 0,
      },
      {
        plan_version_id: "pv_3",
        page_id: "page_1",
        plan_views: 5,
        plan_clicks: 5,
        plan_signups: 2,
      },
      { plan_version_id: "pv_1", page_id: null, plan_views: 0, plan_clicks: 0, plan_signups: 1 },
    ])

    const result = await createService(basinSql).getPlansConversion({
      projectId: "proj_1",
      intervalDays: 7,
    })

    expect(result).toEqual({
      val: {
        data: [
          {
            page_id: "page_1",
            plan_version_id: "pv_3",
            plan_views: 5,
            plan_clicks: 5,
            plan_signups: 2,
            conversion: 40,
          },
          {
            page_id: "page_1",
            plan_version_id: "pv_1",
            plan_views: 10,
            plan_clicks: 4,
            plan_signups: 2,
            conversion: 20,
          },
        ],
      },
    })
  })

  it("returns the session's latest plan click", async () => {
    const { basinSql } = fakeBasinSql([
      {
        timestamp: "2026-11-03T10:00:00.000Z",
        session_id: "sess_1",
        plan_version_id: "pv_1",
        page_id: "page_1",
      },
    ])

    const result = await createService(basinSql).getPlanClickBySessionId({
      projectId: "proj_1",
      sessionId: "sess_1",
    })

    expect(result).toEqual({
      val: {
        timestamp: new Date("2026-11-03T10:00:00.000Z"),
        session_id: "sess_1",
        payload: { plan_version_id: "pv_1", page_id: "page_1" },
      },
    })
  })

  it("returns null when the session has no plan click", async () => {
    const { basinSql } = fakeBasinSql([])

    const result = await createService(basinSql).getPlanClickBySessionId({
      projectId: "proj_1",
      sessionId: "sess_1",
    })

    expect(result).toEqual({ val: null })
  })

  it("maps a Basin SQL failure to a FetchError", async () => {
    const basinSql: BasinSql = {
      query: async () =>
        Err(
          new BasinSqlError({ code: "TIMEOUT", message: "Basin SQL query timed out after 10000ms" })
        ),
    }

    const result = await createService(basinSql).getPlansConversion({ projectId: "proj_1" })

    expect(result.err?.message).toBe(
      "failed to fetch plans conversion: Basin SQL query timed out after 10000ms"
    )
  })
})
