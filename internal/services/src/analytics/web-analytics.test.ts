import { describe, expect, it } from "vitest"
import {
  buildPageDimensionSql,
  buildPagesOverviewSql,
  buildPlansConversionSql,
  webAnalyticsWindow,
} from "./web-analytics"

const now = Date.UTC(2026, 10, 3, 10, 30)
const window = webAnalyticsWindow(now, 7)

describe("web analytics SQL builders", () => {
  it("bounds the window from the start of the UTC day intervalDays ago to now", () => {
    expect(window).toEqual({
      from: new Date("2026-10-27T00:00:00.000Z"),
      to: new Date("2026-11-03T10:30:00.000Z"),
    })
  })

  it("builds the top countries query", () => {
    expect(
      buildPageDimensionSql({
        projectId: "proj_1",
        pageId: "page_1",
        dimension: "country",
        window,
      })
    ).toBe(`SELECT page_id, country, COUNT(DISTINCT session_id) AS visits, COUNT(DISTINCT event_id) AS hits
FROM lakehouse.web_events
WHERE project_id = 'proj_1'
  AND kind = 'page_hit'
  AND page_id = 'page_1'
  AND __ingest_ts >= '2026-10-27T00:00:00.000Z'
  AND timestamp >= '2026-10-27T00:00:00.000Z'
  AND timestamp <= '2026-11-03T10:30:00.000Z'
GROUP BY page_id, country
ORDER BY visits DESC
LIMIT 50`)
  })

  it("builds the top browsers query", () => {
    expect(
      buildPageDimensionSql({
        projectId: "proj_1",
        pageId: "page_1",
        dimension: "browser",
        window,
      })
    ).toBe(`SELECT page_id, browser, COUNT(DISTINCT session_id) AS visits, COUNT(DISTINCT event_id) AS hits
FROM lakehouse.web_events
WHERE project_id = 'proj_1'
  AND kind = 'page_hit'
  AND page_id = 'page_1'
  AND __ingest_ts >= '2026-10-27T00:00:00.000Z'
  AND timestamp >= '2026-10-27T00:00:00.000Z'
  AND timestamp <= '2026-11-03T10:30:00.000Z'
GROUP BY page_id, browser
ORDER BY visits DESC
LIMIT 50`)
  })

  it("builds the pages overview query for all pages, bucketed by hour", () => {
    expect(
      buildPagesOverviewSql({
        projectId: "proj_1",
        bucket: "hour",
        window: webAnalyticsWindow(now, 1),
      })
    ).toBe(`SELECT date_trunc('hour', timestamp) AS bucket, page_id, device, COUNT(DISTINCT session_id) AS visits, COUNT(DISTINCT event_id) AS hits
FROM lakehouse.web_events
WHERE project_id = 'proj_1'
  AND kind = 'page_hit'
  AND __ingest_ts >= '2026-11-02T00:00:00.000Z'
  AND timestamp >= '2026-11-02T00:00:00.000Z'
  AND timestamp <= '2026-11-03T10:30:00.000Z'
GROUP BY date_trunc('hour', timestamp), page_id, device
ORDER BY bucket DESC
LIMIT 10000`)
  })

  it("builds the plans conversion query", () => {
    expect(
      buildPlansConversionSql({ projectId: "proj_1", window })
    ).toBe(`SELECT plan_version_id, page_id,
  COUNT(DISTINCT CASE WHEN kind = 'plan_view' THEN session_id END) AS plan_views,
  COUNT(DISTINCT CASE WHEN kind = 'plan_click' THEN session_id END) AS plan_clicks,
  COUNT(DISTINCT CASE WHEN kind = 'signup' AND signup_status = 'signup_success' THEN customer_id END) AS plan_signups
FROM lakehouse.web_events
WHERE project_id = 'proj_1'
  AND kind IN ('plan_view', 'plan_click', 'signup')
  AND __ingest_ts >= '2026-10-27T00:00:00.000Z'
  AND timestamp >= '2026-10-27T00:00:00.000Z'
  AND timestamp <= '2026-11-03T10:30:00.000Z'
GROUP BY plan_version_id, page_id
ORDER BY plan_signups DESC, plan_clicks DESC, plan_views DESC
LIMIT 1000`)
  })

  it("escapes a malicious page id into a single string literal", () => {
    const sql = buildPageDimensionSql({
      projectId: "proj_1",
      pageId: "x' OR project_id <> 'proj_1",
      dimension: "country",
      window,
    })

    expect(sql).toContain("  AND page_id = 'x'' OR project_id <> ''proj_1'\n")
  })
})
