import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  buildEventFacetsSql,
  buildEventTimelineSql,
  buildEventTotalsSql,
  buildFeatureUsageSql,
  buildRecentEventsSql,
  buildRejectedEventSql,
  buildRejectionsSql,
  buildStatementEventsSql,
  buildTopPayersSql,
  customerOfKey,
  eventFacetSqlRowSchema,
  featureUsageSqlRowSchema,
  parseSignedDecimal,
  recentEventSqlRowSchema,
  rejectedEventSqlRowSchema,
  statementEventSqlRowSchema,
  topPayersSqlRowSchema,
} from "./budget-journal"

const window = {
  from: new Date("2026-11-01T00:00:00.000Z"),
  to: new Date("2026-11-03T10:30:00.000Z"),
}

const latest = (budget: string, kinds: string, rejected: boolean) =>
  `WITH latest AS (
  SELECT budget_key, operation_id, kind, status, timestamp, data
  FROM lakehouse.budget_journal
  WHERE project_id = 'proj_1'
    AND ${budget}
    AND kind IN (${kinds})
${rejected ? "" : "    AND status <> 'rejected'\n"}    AND __ingest_ts >= '2026-11-01T00:00:00.000Z'
    AND timestamp >= '2026-11-01T00:00:00.000Z'
    AND timestamp <= '2026-11-03T10:30:00.000Z'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY budget_key, operation_id ORDER BY seq DESC) = 1
)`

const allPayers = "starts_with(budget_key, 'unprice:customer:')"
const onePayer = "budget_key = 'unprice:customer:cus_1'"

const events = `events AS (
  SELECT budget_key, operation_id, kind, timestamp,
    CASE WHEN status = 'rejected' THEN 'rejected' ELSE 'processed' END AS state,
    COALESCE(json_get_str(data, 'priced', 'slug'), json_get_str(data, 'event', 'slug')) AS event_slug,
    json_get_str(data, 'idempotencyKey') AS idempotency_key,
    json_get_str(data, 'rejection', 'code') AS rejection_reason,
    COALESCE(json_get_int(data, 'priced', 'at'), json_get_int(data, 'occurredAt')) AS occurred_at
  FROM latest
)`

const slot = (
  index: number
) => `  SELECT budget_key, bucket, json_get_str(features, ${index}, 'featureSlug') AS feature_slug,
    json_get_str(features, ${index}, 'meterQuantity') AS quantity, json_get_str(features, ${index}, 'amount') AS amount
  FROM consumed WHERE json_length(features) > ${index}`

const lines = `lines AS (
${[0, 1, 2, 3, 4, 5, 6, 7].map(slot).join("\n  UNION ALL\n")}
  UNION ALL
  SELECT budget_key, bucket, NULL AS feature_slug, NULL AS quantity, NULL AS amount
  FROM consumed WHERE json_length(features) > 8
)`

describe("budget journal SQL builders", () => {
  it("builds per-day feature usage for one payer, latest seq per operation", () => {
    expect(
      buildFeatureUsageSql({ projectId: "proj_1", customerId: "cus_1", window, bucket: "day" })
    ).toBe(`${latest(onePayer, "'charge', 'record', 'hold'", false)},
consumed AS (
  SELECT budget_key, date_trunc('day', timestamp) AS bucket, COALESCE(json_get_json(data, 'priced', 'features'), json_get_json(data, 'state', 'priced', 'features')) AS features
  FROM latest
  WHERE ((kind IN ('charge', 'record') AND status = 'done') OR (kind = 'hold' AND status = 'settled'))
),
${lines}
SELECT bucket, feature_slug, COUNT(*) AS events,
  CAST(SUM(CAST(quantity AS DECIMAL(38, 8))) AS VARCHAR) AS quantity, CAST(SUM(CAST(amount AS DECIMAL(38, 8))) AS VARCHAR) AS amount
FROM lines
GROUP BY bucket, feature_slug
ORDER BY bucket DESC, feature_slug
LIMIT 10000`)
  })

  it("builds feature usage per customer across the project's payer budgets", () => {
    expect(buildFeatureUsageSql({ projectId: "proj_1", window, byCustomer: true })).toBe(`${latest(
      allPayers,
      "'charge', 'record', 'hold'",
      false
    )},
consumed AS (
  SELECT budget_key, NULL AS bucket, COALESCE(json_get_json(data, 'priced', 'features'), json_get_json(data, 'state', 'priced', 'features')) AS features
  FROM latest
  WHERE ((kind IN ('charge', 'record') AND status = 'done') OR (kind = 'hold' AND status = 'settled'))
),
${lines}
SELECT budget_key, feature_slug, COUNT(*) AS events,
  CAST(SUM(CAST(quantity AS DECIMAL(38, 8))) AS VARCHAR) AS quantity, CAST(SUM(CAST(amount AS DECIMAL(38, 8))) AS VARCHAR) AS amount
FROM lines
GROUP BY budget_key, feature_slug
ORDER BY budget_key, feature_slug
LIMIT 10000`)
  })

  it("escapes every value it interpolates", () => {
    const sql = buildFeatureUsageSql({ projectId: "p'1", customerId: "c'1", window })
    expect(sql).toContain("WHERE project_id = 'p''1'")
    expect(sql).toContain("AND budget_key = 'unprice:customer:c''1'")
  })

  it("builds the top payers", () => {
    expect(buildTopPayersSql({ projectId: "proj_1", window, limit: 10 })).toBe(`${latest(
      allPayers,
      "'charge', 'record', 'hold'",
      false
    )},
totals AS (
  SELECT budget_key, COUNT(*) AS events, SUM(CAST(COALESCE(json_get_str(data, 'usage', 'amount'), json_get_str(data, 'state', 'actual', 'amount')) AS DECIMAL(38, 8))) AS amount_total
  FROM latest
  WHERE ((kind IN ('charge', 'record') AND status = 'done') OR (kind = 'hold' AND status = 'settled'))
  GROUP BY budget_key
)
SELECT budget_key, events, CAST(amount_total AS VARCHAR) AS amount
FROM totals
ORDER BY amount_total DESC, events DESC, budget_key
LIMIT 10`)
  })

  it("builds event totals, keeping rejected rows by status", () => {
    expect(buildEventTotalsSql({ projectId: "proj_1", window })).toBe(`${latest(
      allPayers,
      "'charge', 'record'",
      true
    )},
${events}
SELECT state, COUNT(*) AS events, MAX(timestamp) AS last_seen_at
FROM events
WHERE TRUE
GROUP BY state`)
  })

  it("builds the per-minute timeline", () => {
    expect(buildEventTimelineSql({ projectId: "proj_1", window })).toBe(`${latest(
      allPayers,
      "'charge', 'record'",
      true
    )},
${events}
SELECT date_trunc('minute', timestamp) AS bucket, state, COUNT(*) AS events
FROM events
WHERE TRUE
GROUP BY date_trunc('minute', timestamp), state
ORDER BY bucket DESC
LIMIT 2880`)
  })

  it("builds rejections grouped by reason and slug", () => {
    expect(buildRejectionsSql({ projectId: "proj_1", window, limit: 50 })).toBe(`${latest(
      allPayers,
      "'charge', 'record'",
      true
    )},
${events}
SELECT rejection_reason, event_slug, kind, COUNT(*) AS events, MAX(timestamp) AS last_seen_at
FROM events
WHERE state = 'rejected'
GROUP BY rejection_reason, event_slug, kind
ORDER BY events DESC, last_seen_at DESC
LIMIT 50`)
  })

  it("builds a page of recent events after a cursor, with filters and an escaped search", () => {
    expect(
      buildRecentEventsSql({
        projectId: "proj_1",
        customerId: "cus_1",
        window,
        limit: 51,
        cursor: { handledAt: Date.parse("2026-11-03T10:00:00.000Z"), operationId: "o:abc" },
        filter: {
          customerIds: ["cus_2"],
          eventSlugs: ["tokens"],
          rejectionReasons: ["LIMIT_EXCEEDED"],
          states: ["rejected"],
          kinds: ["record"],
          search: "O'Brien",
        },
      })
    ).toBe(`${latest(onePayer, "'charge', 'record'", true)},
${events}
SELECT budget_key, operation_id, kind, state, timestamp, event_slug, idempotency_key, rejection_reason, occurred_at
FROM events
WHERE (timestamp < '2026-11-03T10:00:00.000Z' OR (timestamp = '2026-11-03T10:00:00.000Z' AND operation_id < 'o:abc'))
  AND budget_key IN ('unprice:customer:cus_2')
  AND event_slug IN ('tokens')
  AND rejection_reason IN ('LIMIT_EXCEEDED')
  AND state IN ('rejected')
  AND kind IN ('record')
  AND (strpos(lower(COALESCE(idempotency_key, '')), 'o''brien') > 0 OR strpos(lower(COALESCE(event_slug, '')), 'o''brien') > 0 OR strpos(lower(COALESCE(budget_key, '')), 'o''brien') > 0 OR strpos(lower(COALESCE(rejection_reason, '')), 'o''brien') > 0 OR strpos(lower(COALESCE(operation_id, '')), 'o''brien') > 0)
ORDER BY timestamp DESC, operation_id DESC
LIMIT 51`)
  })

  it("builds the facets, a bounded number per facet", () => {
    expect(buildEventFacetsSql({ projectId: "proj_1", window, limit: 50 })).toBe(`${latest(
      allPayers,
      "'charge', 'record'",
      true
    )},
${events},
facets AS (
  SELECT 'event_slug' AS facet, event_slug AS value, COUNT(*) AS events
  FROM events
  WHERE event_slug IS NOT NULL
  GROUP BY event_slug
  UNION ALL
  SELECT 'rejection_reason' AS facet, rejection_reason AS value, COUNT(*) AS events
  FROM events
  WHERE rejection_reason IS NOT NULL
  GROUP BY rejection_reason
  UNION ALL
  SELECT 'budget_key' AS facet, budget_key AS value, COUNT(*) AS events
  FROM events
  WHERE budget_key IS NOT NULL
  GROUP BY budget_key
)
SELECT facet, value, events
FROM facets
QUALIFY ROW_NUMBER() OVER (PARTITION BY facet ORDER BY events DESC, value) <= 50
ORDER BY facet, events DESC, value`)
  })

  it("builds the lookup of one rejected event", () => {
    expect(
      buildRejectedEventSql({
        projectId: "proj_1",
        customerId: "cus_1",
        operationId: "r:key'1",
        handledAt: Date.parse("2026-11-03T10:00:00.000Z"),
      })
    ).toBe(`SELECT budget_key, operation_id, timestamp, data
FROM lakehouse.budget_journal
WHERE project_id = 'proj_1'
  AND budget_key = 'unprice:customer:cus_1'
  AND operation_id = 'r:key''1'
  AND status = 'rejected'
  AND __ingest_ts >= '2026-11-03T10:00:00.000Z'
  AND timestamp = '2026-11-03T10:00:00.000Z'
LIMIT 1`)
  })

  it("builds the events of one statement", () => {
    expect(
      buildStatementEventsSql({
        projectId: "proj_1",
        customerId: "cus_1",
        periodId: "tokens:bp_1",
        window,
        limit: 100,
        offset: 20,
      })
    ).toBe(`${latest(onePayer, "'charge', 'record'", false)}
SELECT operation_id, timestamp, data, COUNT(*) OVER () AS total
FROM latest
WHERE (json_get_str(data, 'priced', 'features', 0, 'periodId') = 'tokens:bp_1'
  OR json_get_str(data, 'priced', 'features', 1, 'periodId') = 'tokens:bp_1'
  OR json_get_str(data, 'priced', 'features', 2, 'periodId') = 'tokens:bp_1'
  OR json_get_str(data, 'priced', 'features', 3, 'periodId') = 'tokens:bp_1'
  OR json_get_str(data, 'priced', 'features', 4, 'periodId') = 'tokens:bp_1'
  OR json_get_str(data, 'priced', 'features', 5, 'periodId') = 'tokens:bp_1'
  OR json_get_str(data, 'priced', 'features', 6, 'periodId') = 'tokens:bp_1'
  OR json_get_str(data, 'priced', 'features', 7, 'periodId') = 'tokens:bp_1')
ORDER BY timestamp DESC, operation_id DESC
LIMIT 100
OFFSET 20`)
  })
})

describe("budget journal rows", () => {
  it("parses signed decimals to base units at the ledger scale", () => {
    expect(parseSignedDecimal("12.50000000")).toBe(BigInt(1_250_000_000))
    expect(parseSignedDecimal("-0.1")).toBe(BigInt(-10_000_000))
    expect(parseSignedDecimal("7")).toBe(BigInt(700_000_000))
    expect(parseSignedDecimal("0.000000001")).toBeNull()
    expect(parseSignedDecimal("1e5")).toBeNull()
  })

  it("parses feature usage rows, null sums as zero", () => {
    const rows = z.array(featureUsageSqlRowSchema).parse([
      {
        bucket: "2026-11-02T00:00:00Z",
        feature_slug: "tokens",
        events: "3",
        quantity: "1500.00000000",
        amount: "0.75000000",
      },
      { bucket: null, feature_slug: null, events: 2, quantity: null, amount: null },
    ])
    expect(rows).toEqual([
      {
        bucket: new Date("2026-11-02T00:00:00Z"),
        feature_slug: "tokens",
        events: 3,
        quantity: BigInt(150_000_000_000),
        amount: BigInt(75_000_000),
      },
      { bucket: null, feature_slug: null, events: 2, quantity: BigInt(0), amount: BigInt(0) },
    ])
    expect(() =>
      featureUsageSqlRowSchema.parse({ feature_slug: "x", events: 1, quantity: "abc", amount: "1" })
    ).toThrow()
  })

  it("parses top payers, recent events, facets, and journal data", () => {
    expect(
      topPayersSqlRowSchema.parse({ budget_key: "unprice:customer:c", events: 4, amount: "-2" })
    ).toEqual({ budget_key: "unprice:customer:c", events: 4, amount: BigInt(-200_000_000) })
    expect(
      recentEventSqlRowSchema.parse({
        budget_key: "unprice:customer:c",
        operation_id: "r:k",
        kind: "record",
        state: "rejected",
        timestamp: "2026-11-03T10:00:00.000Z",
        event_slug: "tokens",
        idempotency_key: "k",
        rejection_reason: "LIMIT_EXCEEDED",
        occurred_at: "1762163999000",
      })
    ).toMatchObject({ timestamp: new Date("2026-11-03T10:00:00.000Z"), occurred_at: 1762163999000 })
    expect(eventFacetSqlRowSchema.parse({ facet: "budget_key", value: "x", events: "9" })).toEqual({
      facet: "budget_key",
      value: "x",
      events: 9,
    })
    expect(
      rejectedEventSqlRowSchema.parse({
        budget_key: "k",
        operation_id: "r:k",
        timestamp: "2026-11-03T10:00:00.000Z",
        data: { event: { slug: "tokens" } },
      }).data
    ).toBe('{"event":{"slug":"tokens"}}')
    expect(
      statementEventSqlRowSchema.parse({
        operation_id: "o:1",
        timestamp: "2026-11-03T10:00:00.000Z",
        data: "{}",
        total: "12",
      }).total
    ).toBe(12)
  })

  it("reads the customer of a payer budget key only", () => {
    expect(customerOfKey("unprice:customer:cus_1")).toBe("cus_1")
    expect(customerOfKey("run:abc")).toBeNull()
  })
})
