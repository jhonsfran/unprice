import { Ok, type Result } from "@unprice/error"
import {
  type BasinSql,
  type BasinSqlError,
  WEB_EVENTS_TABLE,
  type WebEventKind,
  type WebEventRow,
  type WebEventsWriter,
  sqlInteger,
  sqlString,
  sqlTimestamp,
} from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import { z } from "zod"

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export type WebAnalyticsWindow = { from: Date; to: Date }

/**
 * From the start of the UTC day `intervalDays` days ago until `now`: the window the Tinybird
 * endpoints used (`date >= toStartOfDay(today() - interval_days)`).
 */
export function webAnalyticsWindow(now: number, intervalDays: number): WebAnalyticsWindow {
  const startOfToday = Math.floor(now / DAY_MS) * DAY_MS
  return { from: new Date(startOfToday - intervalDays * DAY_MS), to: new Date(now) }
}

/**
 * Every query scopes to one project and a bounded window. `__ingest_ts` is the sink's day
 * partition and is never earlier than the event time, so filtering it on `from` prunes files
 * without dropping rows.
 */
function webEventsWhere(opts: {
  projectId: string
  kinds: readonly WebEventKind[]
  window: WebAnalyticsWindow
  pageId?: string
  sessionId?: string
}): string {
  const kinds =
    opts.kinds.length === 1
      ? `kind = ${sqlString(opts.kinds[0]!)}`
      : `kind IN (${opts.kinds.map(sqlString).join(", ")})`

  return [
    `WHERE project_id = ${sqlString(opts.projectId)}`,
    `  AND ${kinds}`,
    ...(opts.pageId === undefined ? [] : [`  AND page_id = ${sqlString(opts.pageId)}`]),
    ...(opts.sessionId === undefined ? [] : [`  AND session_id = ${sqlString(opts.sessionId)}`]),
    `  AND __ingest_ts >= ${sqlTimestamp(opts.window.from)}`,
    `  AND timestamp >= ${sqlTimestamp(opts.window.from)}`,
    `  AND timestamp <= ${sqlTimestamp(opts.window.to)}`,
  ].join("\n")
}

const count = z.coerce.number()

// ---- top countries / top browsers (v1_get_top_countries, v1_get_top_browsers) ----

export const pageCountryVisitSchema = z.object({
  page_id: z.string(),
  country: z.string(),
  visits: z.number(),
  hits: z.number(),
})
export type PageCountryVisits = z.infer<typeof pageCountryVisitSchema>[]

export const pageBrowserVisitSchema = z.object({
  page_id: z.string(),
  browser: z.string(),
  visits: z.number(),
  hits: z.number(),
})
export type PageBrowserVisits = z.infer<typeof pageBrowserVisitSchema>[]

export const PAGE_DIMENSIONS = ["country", "browser"] as const
export type PageDimension = (typeof PAGE_DIMENSIONS)[number]

/** Visits are distinct sessions, hits are page_hit rows, per page and dimension value. */
export function buildPageDimensionSql(opts: {
  projectId: string
  pageId: string
  dimension: PageDimension
  window: WebAnalyticsWindow
  limit?: number
}): string {
  return [
    `SELECT page_id, ${opts.dimension}, COUNT(DISTINCT session_id) AS visits, COUNT(*) AS hits`,
    `FROM ${WEB_EVENTS_TABLE}`,
    webEventsWhere({
      projectId: opts.projectId,
      kinds: ["page_hit"],
      window: opts.window,
      pageId: opts.pageId,
    }),
    `GROUP BY page_id, ${opts.dimension}`,
    "ORDER BY visits DESC",
    `LIMIT ${sqlInteger(opts.limit ?? 50)}`,
  ].join("\n")
}

export function pageDimensionRowSchema<D extends PageDimension>(dimension: D) {
  return z
    .object({
      page_id: z.string(),
      [dimension]: z.string().nullable(),
      visits: count,
      hits: count,
    })
    .transform((row) => ({
      page_id: row.page_id,
      [dimension]: (row[dimension] as string | null) ?? "Unknown",
      visits: row.visits,
      hits: row.hits,
    })) as unknown as z.ZodType<
    { page_id: string; visits: number; hits: number } & Record<D, string>
  >
}

// ---- pages overview (v1_get_pages_overview) ----

export const pageOverviewSchema = z.object({
  date: z.date(),
  page_id: z.string(),
  desktop_visits: z.number(),
  mobile_visits: z.number(),
  other_visits: z.number(),
  desktop_hits: z.number(),
  mobile_hits: z.number(),
  other_hits: z.number(),
  total_visits: z.number(),
  total_hits: z.number(),
})
export type PageOverview = z.infer<typeof pageOverviewSchema>[]

export type OverviewBucket = "hour" | "day"

/** The Tinybird pipe bucketed by hour for a one-day interval and by day otherwise. */
export function overviewBucket(intervalDays: number): OverviewBucket {
  return intervalDays === 1 ? "hour" : "day"
}

export function buildPagesOverviewSql(opts: {
  projectId: string
  pageId?: string
  bucket: OverviewBucket
  window: WebAnalyticsWindow
}): string {
  const bucket = `date_trunc(${sqlString(opts.bucket)}, timestamp)`
  return [
    `SELECT ${bucket} AS bucket, page_id, device, COUNT(DISTINCT session_id) AS visits, COUNT(*) AS hits`,
    `FROM ${WEB_EVENTS_TABLE}`,
    webEventsWhere({
      projectId: opts.projectId,
      kinds: ["page_hit"],
      window: opts.window,
      pageId: opts.pageId,
    }),
    `GROUP BY ${bucket}, page_id, device`,
    "ORDER BY bucket",
    "LIMIT 10000",
  ].join("\n")
}

export const pagesOverviewSqlRowSchema = z.object({
  bucket: z.coerce.date(),
  page_id: z.string(),
  device: z.string().nullable(),
  visits: count,
  hits: count,
})
type PagesOverviewSqlRow = z.infer<typeof pagesOverviewSqlRowSchema>

/**
 * Folds per-device rows into one row per bucket and page, and fills empty buckets with a zero row
 * (page_id is the filtered page or ""), as the Tinybird interval join did. Tablets count only in
 * the totals, as before.
 */
export function foldPagesOverview(
  rows: readonly PagesOverviewSqlRow[],
  opts: { window: WebAnalyticsWindow; bucket: OverviewBucket; pageId?: string }
): PageOverview {
  const step = opts.bucket === "hour" ? HOUR_MS : DAY_MS
  const byBucket = new Map<number, Map<string, z.infer<typeof pageOverviewSchema>>>()

  for (const row of rows) {
    const bucket = Math.floor(row.bucket.getTime() / step) * step
    const pages = byBucket.get(bucket) ?? new Map()
    byBucket.set(bucket, pages)

    const entry = pages.get(row.page_id) ?? zeroOverview(new Date(bucket), row.page_id)
    pages.set(row.page_id, entry)

    const device = row.device?.toLowerCase() ?? ""
    if (device === "desktop") {
      entry.desktop_visits += row.visits
      entry.desktop_hits += row.hits
    } else if (device === "mobile") {
      entry.mobile_visits += row.visits
      entry.mobile_hits += row.hits
    } else if (device !== "tablet") {
      entry.other_visits += row.visits
      entry.other_hits += row.hits
    }
    entry.total_visits += row.visits
    entry.total_hits += row.hits
  }

  const result: PageOverview = []
  const first = Math.floor(opts.window.from.getTime() / step) * step
  const last = Math.floor(opts.window.to.getTime() / step) * step
  for (let bucket = first; bucket <= last; bucket += step) {
    const pages = byBucket.get(bucket)
    if (!pages) {
      result.push(zeroOverview(new Date(bucket), opts.pageId ?? ""))
      continue
    }
    result.push(...[...pages.values()].sort((a, b) => a.page_id.localeCompare(b.page_id)))
  }
  return result
}

function zeroOverview(date: Date, pageId: string): z.infer<typeof pageOverviewSchema> {
  return {
    date,
    page_id: pageId,
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

// ---- plans conversion (v1_get_plans_conversion) ----

export const planConversionSchema = z.object({
  page_id: z.string(),
  plan_version_id: z.string(),
  plan_views: z.number(),
  plan_clicks: z.number(),
  plan_signups: z.number(),
  conversion: z.number(),
})
export type PlansConversion = z.infer<typeof planConversionSchema>[]

/**
 * Views and clicks are distinct sessions. Sign-ups are distinct customers with a `signup_success`
 * row: the Tinybird pipe merged the latest status per (plan version, page), so it counted at most
 * one sign-up per plan version and page.
 */
export function buildPlansConversionSql(opts: {
  projectId: string
  window: WebAnalyticsWindow
}): string {
  return [
    "SELECT plan_version_id, page_id,",
    "  COUNT(DISTINCT CASE WHEN kind = 'plan_view' THEN session_id END) AS plan_views,",
    "  COUNT(DISTINCT CASE WHEN kind = 'plan_click' THEN session_id END) AS plan_clicks,",
    "  COUNT(DISTINCT CASE WHEN kind = 'signup' AND signup_status = 'signup_success' THEN customer_id END) AS plan_signups",
    `FROM ${WEB_EVENTS_TABLE}`,
    webEventsWhere({
      projectId: opts.projectId,
      kinds: ["plan_view", "plan_click", "signup"],
      window: opts.window,
    }),
    "GROUP BY plan_version_id, page_id",
    "ORDER BY plan_views DESC",
    "LIMIT 1000",
  ].join("\n")
}

export const plansConversionSqlRowSchema = z.object({
  plan_version_id: z.string().nullable(),
  page_id: z.string().nullable(),
  plan_views: count,
  plan_clicks: count,
  plan_signups: count,
})

/** Keeps plan versions that were viewed (the pipe left-joined from views) and the top 100. */
export function foldPlansConversion(
  rows: readonly z.infer<typeof plansConversionSqlRowSchema>[]
): PlansConversion {
  return rows
    .flatMap((row) =>
      row.plan_views > 0 && row.page_id && row.plan_version_id
        ? [
            {
              page_id: row.page_id,
              plan_version_id: row.plan_version_id,
              plan_views: row.plan_views,
              plan_clicks: row.plan_clicks,
              plan_signups: row.plan_signups,
              conversion: (row.plan_signups / row.plan_views) * 100,
            },
          ]
        : []
    )
    .sort(
      (a, b) =>
        b.conversion - a.conversion ||
        b.plan_views - a.plan_views ||
        b.plan_clicks - a.plan_clicks ||
        b.plan_signups - a.plan_signups
    )
    .slice(0, 100)
}

// ---- plan click attribution (v1_get_session_event) ----

export const planClickSchema = z.object({
  timestamp: z.date(),
  session_id: z.string(),
  payload: z.object({ plan_version_id: z.string(), page_id: z.string() }),
})
export type PlanClick = z.infer<typeof planClickSchema>

export function buildLatestPlanClickSql(opts: {
  projectId: string
  sessionId: string
  window: WebAnalyticsWindow
}): string {
  return [
    "SELECT timestamp, session_id, plan_version_id, page_id",
    `FROM ${WEB_EVENTS_TABLE}`,
    webEventsWhere({
      projectId: opts.projectId,
      kinds: ["plan_click"],
      window: opts.window,
      sessionId: opts.sessionId,
    }),
    "ORDER BY timestamp DESC",
    "LIMIT 1",
  ].join("\n")
}

const latestPlanClickRowSchema = z
  .object({
    timestamp: z.coerce.date(),
    session_id: z.string(),
    plan_version_id: z.string(),
    page_id: z.string(),
  })
  .transform(
    (row): PlanClick => ({
      timestamp: row.timestamp,
      session_id: row.session_id,
      payload: { plan_version_id: row.plan_version_id, page_id: row.page_id },
    })
  )

/** The session's latest plan click within `intervalDays` days before `now` (one day by default). */
export async function findLatestPlanClick(
  basinSql: BasinSql,
  opts: { projectId: string; sessionId: string; now: number; intervalDays?: number }
): Promise<Result<PlanClick | null, BasinSqlError>> {
  const window = {
    from: new Date(opts.now - (opts.intervalDays ?? 1) * DAY_MS),
    to: new Date(opts.now),
  }
  const result = await basinSql.query(
    buildLatestPlanClickSql({ projectId: opts.projectId, sessionId: opts.sessionId, window }),
    latestPlanClickRowSchema
  )
  if (result.err) {
    return result
  }
  return Ok(result.val[0] ?? null)
}

// ---- writes ----

/** Sends rows to the web events stream and logs a failure; never rejects. */
export async function recordWebEvents(
  deps: { webEvents: WebEventsWriter; logger: Logger },
  rows: WebEventRow[]
): Promise<void> {
  const result = await deps.webEvents.send(rows)
  if (!result.err) {
    return
  }
  const fields = { code: result.err.code, kinds: rows.map((row) => row.kind) }
  if (result.err.code === "NOT_CONFIGURED") {
    deps.logger.warn(`web analytics events were not recorded: ${result.err.message}`, fields)
    return
  }
  deps.logger.error(result.err, { context: "web analytics events were not recorded", ...fields })
}
