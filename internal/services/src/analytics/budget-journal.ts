import { BUDGET_MAX_METERED_FEATURES } from "@unprice/db/validators"
import { BUDGET_JOURNAL_TABLE, sqlInteger, sqlString, sqlTimestamp } from "@unprice/lakehouse"
import { LEDGER_SCALE, type SignedAmount } from "@unprice/money"
import { z } from "zod"
import { payerBudgetKey } from "../use-cases/budgets/compile-payer-budget"

/**
 * Usage history read from the budget journal (ADR-0008 D7): every BudgetDO operation row, and every
 * event a payer budget refused, exported to the `budget_journal` Iceberg table and queried with
 * Basin SQL. Each builder scopes to one project and a bounded window, escapes every value, and keeps
 * each operation's highest `seq`, because export is at least once and a reopened row is written
 * again with a new `seq`.
 */

/** Every Unprice customer's budget lives under this prefix: `unprice:customer:<customerId>`. */
export const PAYER_BUDGET_KEY_PREFIX = payerBudgetKey("")

/** The customer of a payer budget key, or null for any other budget. */
export function customerOfKey(budgetKey: string): string | null {
  return budgetKey.startsWith(PAYER_BUDGET_KEY_PREFIX)
    ? budgetKey.slice(PAYER_BUDGET_KEY_PREFIX.length)
    : null
}

export type JournalWindow = { from: Date; to: Date }

export type JournalBucket = "hour" | "day"

/**
 * An event feeds every feature its slug meters, so `priced.features` is an array. Basin SQL has no
 * UNNEST, so a query reads the first this-many entries by index and counts the events that feed
 * more, which a caller reports instead of silently dropping.
 */
export const FEATURE_SLOTS = 8

const SLOTS = Array.from({ length: FEATURE_SLOTS }, (_, index) => index)
const STATEMENT_SLOTS = Array.from({ length: BUDGET_MAX_METERED_FEATURES }, (_, index) => index)

/** The features an operation priced: a charge or record keeps them on `priced`, a hold on its settle. */
const PRICED_FEATURES =
  "COALESCE(json_get_json(data, 'priced', 'features'), json_get_json(data, 'state', 'priced', 'features'))"

/** Usage that consumed: a charge or record (always `done`) and a settled hold. */
const CONSUMED =
  "((kind IN ('charge', 'record') AND status = 'done') OR (kind = 'hold' AND status = 'settled'))"

/**
 * The latest version of each operation row written in the window. `__ingest_ts` is the sink's
 * ingestion time and is never earlier than the row's `timestamp`, so filtering it on `from` prunes
 * files without dropping rows. A row whose last version falls after the window counts at its last
 * version inside it: an open hold there consumed nothing yet.
 */
function latestCte(opts: {
  projectId: string
  /** One customer's payer budget; every payer budget of the project when absent. */
  customerId?: string
  window: JournalWindow
  kinds: readonly string[]
  rejected: "exclude" | "include"
}): string {
  const budget =
    opts.customerId === undefined
      ? `starts_with(budget_key, ${sqlString(PAYER_BUDGET_KEY_PREFIX)})`
      : `budget_key = ${sqlString(payerBudgetKey(opts.customerId))}`
  return [
    "latest AS (",
    "  SELECT budget_key, operation_id, kind, status, timestamp, data",
    `  FROM ${BUDGET_JOURNAL_TABLE}`,
    `  WHERE project_id = ${sqlString(opts.projectId)}`,
    `    AND ${budget}`,
    `    AND kind IN (${opts.kinds.map(sqlString).join(", ")})`,
    ...(opts.rejected === "exclude" ? ["    AND status <> 'rejected'"] : []),
    `    AND __ingest_ts >= ${sqlTimestamp(opts.window.from)}`,
    `    AND timestamp >= ${sqlTimestamp(opts.window.from)}`,
    `    AND timestamp <= ${sqlTimestamp(opts.window.to)}`,
    "  QUALIFY ROW_NUMBER() OVER (PARTITION BY budget_key, operation_id ORDER BY seq DESC) = 1",
    ")",
  ].join("\n")
}

// ---- decimals ----

const DECIMAL_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/

/**
 * A signed decimal from Basin SQL (a DECIMAL cast to text, or a journal amount) as base units at
 * the ledger scale. Usage can price negative (a graduated tier with a smaller flat fee), so the
 * sign is kept; digits past the ledger scale cannot occur at DECIMAL(38, 8) and are refused.
 */
export function parseSignedDecimal(text: string): SignedAmount | null {
  const match = DECIMAL_PATTERN.exec(text.trim())
  if (!match) return null
  const [, sign, whole = "0", fraction = ""] = match
  const trimmed = fraction.replace(/0+$/, "")
  if (trimmed.length > LEDGER_SCALE) return null
  const units =
    BigInt(whole) * BigInt(10 ** LEDGER_SCALE) + BigInt(trimmed.padEnd(LEDGER_SCALE, "0"))
  return sign ? -units : units
}

const decimalSchema = z
  .union([z.string(), z.number()])
  .nullable()
  .transform((value, ctx) => {
    if (value === null) return BigInt(0)
    const parsed = parseSignedDecimal(
      typeof value === "number" ? value.toFixed(LEDGER_SCALE) : value
    )
    if (parsed === null) {
      ctx.addIssue({ code: "custom", message: `not a decimal: ${value}` })
      return z.NEVER
    }
    return parsed
  })

const countSchema = z.coerce.number().int().nonnegative()

/** A JSON column: Basin SQL returns it as text, a test fake may hand back the object. */
const jsonTextSchema = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .transform((value) => (typeof value === "string" ? value : JSON.stringify(value)))

const decimalSum = (column: string) => `CAST(SUM(CAST(${column} AS DECIMAL(38, 8))) AS VARCHAR)`

// ---- feature usage (usage dashboard, analytics.usage.get) ----

/**
 * Quantity and amount per feature of the usage the project's payer budgets consumed in the window:
 * per time bucket when `bucket` is set, per customer when `byCustomer` is. The amount is in the
 * budget's unit (ADR-0008 D4, priced at ingestion). A row with a null `feature_slug` counts the
 * events that fed more than FEATURE_SLOTS features; their extra features are not in the totals.
 */
export function buildFeatureUsageSql(opts: {
  projectId: string
  customerId?: string
  window: JournalWindow
  bucket?: JournalBucket
  byCustomer?: boolean
}): string {
  const bucket = opts.bucket ? `date_trunc(${sqlString(opts.bucket)}, timestamp)` : "NULL"
  const keys = [...(opts.bucket ? ["bucket"] : []), ...(opts.byCustomer ? ["budget_key"] : [])]
  const slot = (index: number) =>
    [
      `  SELECT budget_key, bucket, unit, json_get_str(features, ${index}, 'featureSlug') AS feature_slug,`,
      `    json_get_str(features, ${index}, 'meterQuantity') AS quantity, json_get_str(features, ${index}, 'amount') AS amount`,
      `  FROM consumed WHERE json_length(features) > ${index}`,
    ].join("\n")

  return [
    `WITH ${latestCte({ ...opts, kinds: ["charge", "record", "hold"], rejected: "exclude" })},`,
    "consumed AS (",
    `  SELECT budget_key, ${bucket} AS bucket, json_get_str(data, 'unit') AS unit, ${PRICED_FEATURES} AS features`,
    "  FROM latest",
    `  WHERE ${CONSUMED}`,
    "),",
    "lines AS (",
    SLOTS.map(slot).join("\n  UNION ALL\n"),
    "  UNION ALL",
    "  SELECT budget_key, bucket, unit, NULL AS feature_slug, NULL AS quantity, NULL AS amount",
    `  FROM consumed WHERE json_length(features) > ${FEATURE_SLOTS}`,
    ")",
    [
      "SELECT",
      opts.bucket ? "bucket," : "",
      opts.byCustomer ? "budget_key," : "",
      "feature_slug, unit, COUNT(*) AS events,",
    ]
      .filter(Boolean)
      .join(" "),
    `  ${decimalSum("quantity")} AS quantity, ${decimalSum("amount")} AS amount`,
    "FROM lines",
    `GROUP BY ${[...keys, "feature_slug", "unit"].join(", ")}`,
    `ORDER BY ${[...(opts.bucket ? ["bucket DESC"] : []), ...(opts.byCustomer ? ["budget_key"] : []), "feature_slug", "unit"].join(", ")}`,
    "LIMIT 10000",
  ].join("\n")
}

export const featureUsageSqlRowSchema = z.object({
  bucket: z.coerce.date().nullish(),
  budget_key: z.string().nullish(),
  feature_slug: z.string().nullable(),
  unit: z.string(),
  events: countSchema,
  quantity: decimalSchema,
  amount: decimalSchema,
})

export type FeatureUsageRow = z.infer<typeof featureUsageSqlRowSchema>

/**
 * The customers whose payer budgets consumed the most in the window: events and the amount they
 * cost, in each budget's unit.
 */
export function buildTopPayersSql(opts: {
  projectId: string
  window: JournalWindow
  limit: number
}): string {
  const amount =
    "CAST(COALESCE(json_get_str(data, 'usage', 'amount'), json_get_str(data, 'state', 'actual', 'amount')) AS DECIMAL(38, 8))"
  return [
    `WITH ${latestCte({ ...opts, kinds: ["charge", "record", "hold"], rejected: "exclude" })},`,
    "totals AS (",
    `  SELECT budget_key, json_get_str(data, 'unit') AS unit, COUNT(*) AS events, SUM(${amount}) AS amount_total`,
    "  FROM latest",
    `  WHERE ${CONSUMED}`,
    "  GROUP BY budget_key, json_get_str(data, 'unit')",
    "),",
    "top_payers AS (",
    "  SELECT budget_key, SUM(events) AS payer_events FROM totals",
    "  GROUP BY budget_key ORDER BY payer_events DESC, budget_key",
    `  LIMIT ${sqlInteger(opts.limit)}`,
    ")",
    "SELECT totals.budget_key, totals.unit, totals.events, CAST(totals.amount_total AS VARCHAR) AS amount",
    "FROM totals JOIN top_payers ON totals.budget_key = top_payers.budget_key",
    "ORDER BY top_payers.payer_events DESC, totals.budget_key, totals.unit",
  ].join("\n")
}

export const topPayersSqlRowSchema = z.object({
  budget_key: z.string(),
  unit: z.string(),
  events: countSchema,
  amount: decimalSchema,
})

// ---- usage events (ingestion status, explain-charge, rejected payloads) ----

export const JOURNAL_EVENT_STATES = ["processed", "rejected"] as const
export type JournalEventState = (typeof JOURNAL_EVENT_STATES)[number]

export type JournalEventFilter = {
  customerIds?: readonly string[]
  eventSlugs?: readonly string[]
  rejectionReasons?: readonly string[]
  states?: readonly JournalEventState[]
  /** The usage verb: `record` or `charge`. */
  kinds?: readonly string[]
  search?: string
}

export type JournalEventScope = {
  projectId: string
  customerId?: string
  window: JournalWindow
  filter?: JournalEventFilter
}

/**
 * One row per usage event sent to a payer budget: each accepted charge or record, and each event
 * the budget refused (status `rejected`, written by the API worker with `seq` 0).
 */
function eventsCte(scope: JournalEventScope): string {
  return [
    `WITH ${latestCte({ ...scope, kinds: ["charge", "record"], rejected: "include" })},`,
    "events AS (",
    "  SELECT budget_key, operation_id, kind, timestamp,",
    "    CASE WHEN status = 'rejected' THEN 'rejected' ELSE 'processed' END AS state,",
    "    COALESCE(json_get_str(data, 'priced', 'slug'), json_get_str(data, 'event', 'slug')) AS event_slug,",
    "    json_get_str(data, 'idempotencyKey') AS idempotency_key,",
    "    json_get_str(data, 'rejection', 'code') AS rejection_reason,",
    "    COALESCE(json_get_int(data, 'priced', 'at'), json_get_int(data, 'occurredAt')) AS occurred_at",
    "  FROM latest",
    ")",
  ].join("\n")
}

function inList(column: string, values: readonly string[]): string {
  return `${column} IN (${values.map(sqlString).join(", ")})`
}

/** The filter as one WHERE clause over `events`; "WHERE TRUE" when nothing filters. */
function eventsWhere(filter: JournalEventFilter = {}, extra: readonly string[] = []): string {
  const clauses = [...extra]
  if (filter.customerIds?.length) {
    clauses.push(inList("budget_key", filter.customerIds.map(payerBudgetKey)))
  }
  if (filter.eventSlugs?.length) clauses.push(inList("event_slug", filter.eventSlugs))
  if (filter.rejectionReasons?.length) {
    clauses.push(inList("rejection_reason", filter.rejectionReasons))
  }
  if (filter.states?.length) clauses.push(inList("state", filter.states))
  if (filter.kinds?.length) clauses.push(inList("kind", filter.kinds))
  const search = filter.search?.trim().toLowerCase()
  if (search) {
    const needle = sqlString(search)
    clauses.push(
      `(${["idempotency_key", "event_slug", "budget_key", "rejection_reason", "operation_id"]
        .map((column) => `strpos(lower(COALESCE(${column}, '')), ${needle}) > 0`)
        .join(" OR ")})`
    )
  }
  return clauses.length === 0 ? "WHERE TRUE" : `WHERE ${clauses.join("\n  AND ")}`
}

/** Events per state: exact totals for the window and filter. */
export function buildEventTotalsSql(scope: JournalEventScope): string {
  return [
    eventsCte(scope),
    "SELECT state, COUNT(*) AS events, MAX(timestamp) AS last_seen_at",
    "FROM events",
    eventsWhere(scope.filter),
    "GROUP BY state",
  ].join("\n")
}

export const eventTotalsSqlRowSchema = z.object({
  state: z.enum(JOURNAL_EVENT_STATES),
  events: countSchema,
  last_seen_at: z.coerce.date().nullable(),
})

/** Events per minute and state, newest first. */
export function buildEventTimelineSql(scope: JournalEventScope): string {
  return [
    eventsCte(scope),
    "SELECT date_trunc('minute', timestamp) AS bucket, state, COUNT(*) AS events",
    "FROM events",
    eventsWhere(scope.filter),
    "GROUP BY date_trunc('minute', timestamp), state",
    "ORDER BY bucket DESC",
    "LIMIT 2880",
  ].join("\n")
}

export const eventTimelineSqlRowSchema = z.object({
  bucket: z.coerce.date(),
  state: z.enum(JOURNAL_EVENT_STATES),
  events: countSchema,
})

/** Refused events grouped by why and by event slug, the most frequent first. */
export function buildRejectionsSql(scope: JournalEventScope & { limit: number }): string {
  return [
    eventsCte(scope),
    "SELECT rejection_reason, event_slug, kind, COUNT(*) AS events, MAX(timestamp) AS last_seen_at",
    "FROM events",
    eventsWhere(scope.filter, ["state = 'rejected'"]),
    "GROUP BY rejection_reason, event_slug, kind",
    "ORDER BY events DESC, last_seen_at DESC",
    `LIMIT ${sqlInteger(scope.limit)}`,
  ].join("\n")
}

export const rejectionsSqlRowSchema = z.object({
  rejection_reason: z.string().nullable(),
  event_slug: z.string().nullable(),
  kind: z.string(),
  events: countSchema,
  last_seen_at: z.coerce.date(),
})

/** Operation ids are unique within a budget, so the cursor also includes its budget key. */
export type JournalEventCursor = { handledAt: number; operationId: string; budgetKey: string }

/** The newest events first, `limit` of them after the cursor. */
export function buildRecentEventsSql(
  scope: JournalEventScope & { limit: number; cursor?: JournalEventCursor | null }
): string {
  const cursor = scope.cursor
    ? [
        `(timestamp < ${sqlTimestamp(new Date(scope.cursor.handledAt))} OR (timestamp = ${sqlTimestamp(
          new Date(scope.cursor.handledAt)
        )} AND (operation_id < ${sqlString(scope.cursor.operationId)} OR (operation_id = ${sqlString(
          scope.cursor.operationId
        )} AND budget_key < ${sqlString(scope.cursor.budgetKey)}))))`,
      ]
    : []
  return [
    eventsCte(scope),
    "SELECT budget_key, operation_id, kind, state, timestamp, event_slug, idempotency_key, rejection_reason, occurred_at",
    "FROM events",
    eventsWhere(scope.filter, cursor),
    "ORDER BY timestamp DESC, operation_id DESC, budget_key DESC",
    `LIMIT ${sqlInteger(scope.limit)}`,
  ].join("\n")
}

export const recentEventSqlRowSchema = z.object({
  budget_key: z.string(),
  operation_id: z.string(),
  kind: z.string(),
  state: z.enum(JOURNAL_EVENT_STATES),
  timestamp: z.coerce.date(),
  event_slug: z.string().nullable(),
  idempotency_key: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  occurred_at: z.coerce.number().int().nullable(),
})

export const EVENT_FACETS = ["event_slug", "rejection_reason", "budget_key", "kind"] as const
export type EventFacet = (typeof EVENT_FACETS)[number]

/** The most frequent values of each facet, `limit` per facet. */
export function buildEventFacetsSql(scope: JournalEventScope & { limit: number }): string {
  const facet = (column: EventFacet) =>
    [
      `  SELECT ${sqlString(column)} AS facet, ${column} AS value, COUNT(*) AS events`,
      "  FROM events",
      `  ${eventsWhere(scope.filter, [`${column} IS NOT NULL`]).replaceAll("\n", "\n  ")}`,
      `  GROUP BY ${column}`,
    ].join("\n")
  return [
    `${eventsCte(scope)},`,
    "facets AS (",
    EVENT_FACETS.map(facet).join("\n  UNION ALL\n"),
    ")",
    "SELECT facet, value, events",
    "FROM facets",
    `QUALIFY ROW_NUMBER() OVER (PARTITION BY facet ORDER BY events DESC, value) <= ${sqlInteger(scope.limit)}`,
    "ORDER BY facet, events DESC, value",
  ].join("\n")
}

export const eventFacetSqlRowSchema = z.object({
  facet: z.enum(EVENT_FACETS),
  value: z.string(),
  events: countSchema,
})

/**
 * One refused event, by its operation id (`r:<idempotency key>`) and the time the API journaled it,
 * which bounds the scan to the files ingested since.
 */
export function buildRejectedEventSql(opts: {
  projectId: string
  customerId: string
  operationId: string
  handledAt: number
}): string {
  const at = sqlTimestamp(new Date(opts.handledAt))
  return [
    "SELECT budget_key, operation_id, timestamp, data",
    `FROM ${BUDGET_JOURNAL_TABLE}`,
    `WHERE project_id = ${sqlString(opts.projectId)}`,
    `  AND budget_key = ${sqlString(payerBudgetKey(opts.customerId))}`,
    `  AND operation_id = ${sqlString(opts.operationId)}`,
    "  AND status = 'rejected'",
    `  AND __ingest_ts >= ${at}`,
    `  AND timestamp = ${at}`,
    "LIMIT 1",
  ].join("\n")
}

export const rejectedEventSqlRowSchema = z.object({
  budget_key: z.string(),
  operation_id: z.string(),
  timestamp: z.coerce.date(),
  data: jsonTextSchema,
})

export type StatementScope = {
  projectId: string
  customerId: string
  periodId: string
  window: JournalWindow
}

/**
 * The usage one statement (`<featureSlug>:<billingPeriodId>`) counted: each charge or record and
 * each settled hold one of whose priced features names the statement. The journal keeps no index
 * on statements, so `window` bounds the scan by write time.
 */
function statementCte(scope: StatementScope): string {
  const id = sqlString(scope.periodId)
  return [
    `WITH ${latestCte({ ...scope, kinds: ["charge", "record", "hold"], rejected: "exclude" })},`,
    "consumed AS (",
    `  SELECT operation_id, timestamp, data, ${PRICED_FEATURES} AS features`,
    "  FROM latest",
    `  WHERE ${CONSUMED}`,
    "),",
    "statement AS (",
    "  SELECT operation_id, timestamp, data, features",
    "  FROM consumed",
    `  WHERE (${STATEMENT_SLOTS.map((index) => `json_get_str(features, ${index}, 'periodId') = ${id}`).join("\n    OR ")})`,
    ")",
  ].join("\n")
}

/**
 * A page of the statement's events, newest first, with the whole operation so the caller reads the
 * statement's own feature entry.
 */
export function buildStatementEventsSql(
  opts: StatementScope & { limit: number; offset: number }
): string {
  return [
    statementCte(opts),
    "SELECT operation_id, timestamp, data",
    "FROM statement",
    "ORDER BY timestamp DESC, operation_id DESC",
    `LIMIT ${sqlInteger(opts.limit)}`,
    `OFFSET ${sqlInteger(opts.offset)}`,
  ].join("\n")
}

export const statementEventSqlRowSchema = z.object({
  operation_id: z.string(),
  timestamp: z.coerce.date(),
  data: jsonTextSchema,
})

/** How many events the statement counted, whichever page is read. */
export function buildStatementEventCountSql(scope: StatementScope): string {
  const occurredAt =
    "COALESCE(json_get_int(data, 'priced', 'at'), json_get_int(data, 'state', 'priced', 'at'))"
  const components = `COALESCE(${STATEMENT_SLOTS.map(
    (index) =>
      `CASE WHEN json_get_str(features, ${index}, 'periodId') = ${sqlString(scope.periodId)} THEN json_length(json_get_json(features, ${index}, 'lines')) END`
  ).join(", ")}, 0)`
  return [
    statementCte(scope),
    "SELECT COUNT(*) AS events,",
    `  MIN(${occurredAt}) AS first_event_at, MAX(${occurredAt}) AS last_event_at,`,
    `  COALESCE(SUM(CASE WHEN ${components} > 1 THEN 1 ELSE 0 END), 0) AS multi_component_events`,
    "FROM statement",
  ].join("\n")
}

export const statementEventCountSqlRowSchema = z
  .object({
    events: countSchema,
    first_event_at: z.coerce.number().int().nullable(),
    last_event_at: z.coerce.number().int().nullable(),
    multi_component_events: countSchema,
  })
  .transform((row) => ({
    total: row.events,
    firstEventAt: row.first_event_at,
    lastEventAt: row.last_event_at,
    multiComponentEventCount: row.multi_component_events,
  }))

/** A priced feature of a journaled operation, amounts still as the decimal strings of the export. */
export const journalPricedFeatureSchema = z.object({
  featureSlug: z.string(),
  periodId: z.string(),
  late: z.boolean().optional(),
  meterQuantity: z.string(),
  amount: z.string(),
  cost: z.string().nullable().optional(),
  lines: z.array(z.unknown()).optional(),
})

const journalPricedEventSchema = z.object({
  slug: z.string(),
  at: z.number(),
  features: z.array(journalPricedFeatureSchema),
})

/**
 * The fields of a journaled charge, record, or settled hold that history reads. A charge or record
 * keeps its priced event on `priced`, a settled hold on `state.priced`.
 */
export const journalChargeDataSchema = z.object({
  idempotencyKey: z.string(),
  createdAt: z.number(),
  priced: journalPricedEventSchema.optional(),
  state: z.object({ priced: journalPricedEventSchema.optional() }).optional(),
})
