import {
  WEB_EVENTS_TABLE,
  type WebEventKind,
  type WebEventRow,
  createWebEventRow,
  sqlInteger,
  sqlString,
  sqlTimestamp,
} from "@unprice/lakehouse"
import { z } from "zod"

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export type WebAnalyticsWindow = { from: Date; to: Date }

/**
 * From the start of the UTC day `intervalDays` days ago until `now`.
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
}): string {
  const kinds =
    opts.kinds.length === 1
      ? `kind = ${sqlString(opts.kinds[0]!)}`
      : `kind IN (${opts.kinds.map(sqlString).join(", ")})`

  return [
    `WHERE project_id = ${sqlString(opts.projectId)}`,
    `  AND ${kinds}`,
    ...(opts.pageId === undefined ? [] : [`  AND page_id = ${sqlString(opts.pageId)}`]),
    `  AND __ingest_ts >= ${sqlTimestamp(opts.window.from)}`,
    `  AND timestamp >= ${sqlTimestamp(opts.window.from)}`,
    `  AND timestamp <= ${sqlTimestamp(opts.window.to)}`,
  ].join("\n")
}

const count = z.coerce.number()

// ---- visits by country or browser ----

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

const PAGE_DIMENSIONS = ["country", "browser"] as const
export type PageDimension = (typeof PAGE_DIMENSIONS)[number]

/**
 * Visits are distinct sessions, hits are distinct page_hit rows (by `event_id`, so a retried write
 * counts once), per page and dimension value.
 */
export function buildPageDimensionSql(opts: {
  projectId: string
  pageId: string
  dimension: PageDimension
  window: WebAnalyticsWindow
  limit?: number
}): string {
  return [
    `SELECT page_id, ${opts.dimension}, COUNT(DISTINCT session_id) AS visits, COUNT(DISTINCT event_id) AS hits`,
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

// ---- page overview from Basin SQL ----

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

/** Buckets by hour for a one-day interval and by day otherwise. */
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
    `SELECT ${bucket} AS bucket, page_id, device, COUNT(DISTINCT session_id) AS visits, COUNT(DISTINCT event_id) AS hits`,
    `FROM ${WEB_EVENTS_TABLE}`,
    webEventsWhere({
      projectId: opts.projectId,
      kinds: ["page_hit"],
      window: opts.window,
      pageId: opts.pageId,
    }),
    `GROUP BY ${bucket}, page_id, device`,
    // Newest first, so a window that overflows the limit loses its oldest buckets, not today.
    "ORDER BY bucket DESC",
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
 * (page_id is the filtered page or ""). Tablets count only in the totals.
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

// ---- plan conversion from Basin SQL ----

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
 * row, counted at most once per plan version and page. Groups are ordered by sign-ups, then clicks, then views:
 * the beacon is unauthenticated, so groups made of forged views alone must not push real plans
 * past the limit.
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
    "ORDER BY plan_signups DESC, plan_clicks DESC, plan_views DESC",
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

/** Keeps the 100 viewed plan versions with the highest conversion rates. */
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

// ---- writes ----

export type SignupWebEventStatus = "signup_success" | "waiting_payment_provider_setup"

/** The `signup` row every sign-up path records, so each carries the same attribution fields. */
export function signupWebEventRow(opts: {
  projectId: string
  customerId: string
  planVersion: { id: string; planId: string }
  pageId?: string | null
  status: SignupWebEventStatus
}): WebEventRow {
  return createWebEventRow({
    kind: "signup",
    session_id: "",
    project_id: opts.projectId,
    customer_id: opts.customerId,
    plan_id: opts.planVersion.planId,
    plan_version_id: opts.planVersion.id,
    page_id: opts.pageId ?? undefined,
    signup_status: opts.status,
  })
}
