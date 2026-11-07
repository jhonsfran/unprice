import { DatabaseSync } from "node:sqlite"
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
  buildStatementEventCountSql,
  buildStatementEventsSql,
  buildTopPayersSql,
  customerOfKey,
  eventFacetSqlRowSchema,
  featureUsageSqlRowSchema,
  parseSignedDecimal,
  recentEventSqlRowSchema,
  rejectedEventSqlRowSchema,
  statementEventCountSqlRowSchema,
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
) => `  SELECT budget_key, bucket, unit, json_get_str(features, ${index}, 'featureSlug') AS feature_slug,
    json_get_str(features, ${index}, 'meterQuantity') AS quantity, json_get_str(features, ${index}, 'amount') AS amount
  FROM consumed WHERE json_length(features) > ${index}`

const lines = `lines AS (
${[0, 1, 2, 3, 4, 5, 6, 7].map(slot).join("\n  UNION ALL\n")}
  UNION ALL
  SELECT budget_key, bucket, unit, NULL AS feature_slug, NULL AS quantity, NULL AS amount
  FROM consumed WHERE json_length(features) > 8
)`

describe("budget journal SQL builders", () => {
  it("builds per-day feature usage for one payer, latest seq per operation", () => {
    expect(
      buildFeatureUsageSql({ projectId: "proj_1", customerId: "cus_1", window, bucket: "day" })
    ).toBe(`${latest(onePayer, "'charge', 'record', 'hold'", false)},
consumed AS (
  SELECT budget_key, date_trunc('day', timestamp) AS bucket, json_get_str(data, 'unit') AS unit, COALESCE(json_get_json(data, 'priced', 'features'), json_get_json(data, 'state', 'priced', 'features')) AS features
  FROM latest
  WHERE ((kind IN ('charge', 'record') AND status = 'done') OR (kind = 'hold' AND status = 'settled'))
),
${lines}
SELECT bucket, feature_slug, unit, COUNT(*) AS events,
  CAST(SUM(CAST(quantity AS DECIMAL(38, 8))) AS VARCHAR) AS quantity, CAST(SUM(CAST(amount AS DECIMAL(38, 8))) AS VARCHAR) AS amount
FROM lines
GROUP BY bucket, feature_slug, unit
ORDER BY bucket DESC, feature_slug, unit
LIMIT 10000`)
  })

  it("builds feature usage per customer across the project's payer budgets", () => {
    expect(buildFeatureUsageSql({ projectId: "proj_1", window, byCustomer: true })).toBe(`${latest(
      allPayers,
      "'charge', 'record', 'hold'",
      false
    )},
consumed AS (
  SELECT budget_key, NULL AS bucket, json_get_str(data, 'unit') AS unit, COALESCE(json_get_json(data, 'priced', 'features'), json_get_json(data, 'state', 'priced', 'features')) AS features
  FROM latest
  WHERE ((kind IN ('charge', 'record') AND status = 'done') OR (kind = 'hold' AND status = 'settled'))
),
${lines}
SELECT budget_key, feature_slug, unit, COUNT(*) AS events,
  CAST(SUM(CAST(quantity AS DECIMAL(38, 8))) AS VARCHAR) AS quantity, CAST(SUM(CAST(amount AS DECIMAL(38, 8))) AS VARCHAR) AS amount
FROM lines
GROUP BY budget_key, feature_slug, unit
ORDER BY budget_key, feature_slug, unit
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
  SELECT budget_key, json_get_str(data, 'unit') AS unit, COUNT(*) AS events, SUM(CAST(COALESCE(json_get_str(data, 'usage', 'amount'), json_get_str(data, 'state', 'actual', 'amount')) AS DECIMAL(38, 8))) AS amount_total
  FROM latest
  WHERE ((kind IN ('charge', 'record') AND status = 'done') OR (kind = 'hold' AND status = 'settled'))
  GROUP BY budget_key, json_get_str(data, 'unit')
),
top_payers AS (
  SELECT budget_key, SUM(events) AS payer_events FROM totals
  GROUP BY budget_key ORDER BY payer_events DESC, budget_key
  LIMIT 10
)
SELECT totals.budget_key, totals.unit, totals.events, CAST(totals.amount_total AS VARCHAR) AS amount
FROM totals JOIN top_payers ON totals.budget_key = top_payers.budget_key
ORDER BY top_payers.payer_events DESC, totals.budget_key, totals.unit`)
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
        cursor: {
          handledAt: Date.parse("2026-11-03T10:00:00.000Z"),
          operationId: "o:abc",
          budgetKey: "unprice:customer:cus_1",
        },
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
WHERE (timestamp < '2026-11-03T10:00:00.000Z' OR (timestamp = '2026-11-03T10:00:00.000Z' AND (operation_id < 'o:abc' OR (operation_id = 'o:abc' AND budget_key < 'unprice:customer:cus_1'))))
  AND budget_key IN ('unprice:customer:cus_2')
  AND event_slug IN ('tokens')
  AND rejection_reason IN ('LIMIT_EXCEEDED')
  AND state IN ('rejected')
  AND kind IN ('record')
  AND (strpos(lower(COALESCE(idempotency_key, '')), 'o''brien') > 0 OR strpos(lower(COALESCE(event_slug, '')), 'o''brien') > 0 OR strpos(lower(COALESCE(budget_key, '')), 'o''brien') > 0 OR strpos(lower(COALESCE(rejection_reason, '')), 'o''brien') > 0 OR strpos(lower(COALESCE(operation_id, '')), 'o''brien') > 0)
ORDER BY timestamp DESC, operation_id DESC, budget_key DESC
LIMIT 51`)
  })

  it("pages past an operation id shared by two payer budgets", () => {
    const db = new DatabaseSync(":memory:")
    try {
      db.exec(`CREATE TABLE events (
        budget_key TEXT, operation_id TEXT, kind TEXT, state TEXT, timestamp TEXT,
        event_slug TEXT, idempotency_key TEXT, rejection_reason TEXT, occurred_at INTEGER
      )`)
      const insert = db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      for (const key of ["unprice:customer:cus_1", "unprice:customer:cus_2"]) {
        insert.run(
          key,
          "r:retry",
          "charge",
          "rejected",
          "2026-11-03T10:00:00.000Z",
          "tokens",
          "retry",
          "LIMIT_EXCEEDED",
          null
        )
      }

      const sql = buildRecentEventsSql({
        projectId: "proj_1",
        window,
        limit: 1,
        cursor: {
          handledAt: Date.parse("2026-11-03T10:00:00.000Z"),
          operationId: "r:retry",
          budgetKey: "unprice:customer:cus_2",
        },
      })
      // The events table supplies the CTE's rows; execute the production paging query.
      const page = db.prepare(sql.slice(sql.indexOf("\nSELECT budget_key,") + 1)).all()

      expect(page.map((row) => row.budget_key)).toEqual(["unprice:customer:cus_1"])
    } finally {
      db.close()
    }
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
  UNION ALL
  SELECT 'kind' AS facet, kind AS value, COUNT(*) AS events
  FROM events
  WHERE kind IS NOT NULL
  GROUP BY kind
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
        unit: "money:USD",
        events: "3",
        quantity: "1500.00000000",
        amount: "0.75000000",
      },
      {
        bucket: null,
        feature_slug: null,
        unit: "money:USD",
        events: 2,
        quantity: null,
        amount: null,
      },
    ])
    expect(rows).toEqual([
      {
        bucket: new Date("2026-11-02T00:00:00Z"),
        feature_slug: "tokens",
        unit: "money:USD",
        events: 3,
        quantity: BigInt(150_000_000_000),
        amount: BigInt(75_000_000),
      },
      {
        bucket: null,
        feature_slug: null,
        unit: "money:USD",
        events: 2,
        quantity: BigInt(0),
        amount: BigInt(0),
      },
    ])
    expect(() =>
      featureUsageSqlRowSchema.parse({ feature_slug: "x", events: 1, quantity: "abc", amount: "1" })
    ).toThrow()
  })

  it("parses top payers, recent events, facets, and journal data", () => {
    expect(
      topPayersSqlRowSchema.parse({
        budget_key: "unprice:customer:c",
        unit: "money:USD",
        events: 4,
        amount: "-2",
      })
    ).toEqual({
      budget_key: "unprice:customer:c",
      unit: "money:USD",
      events: 4,
      amount: BigInt(-200_000_000),
    })
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
      })
    ).toEqual({ operation_id: "o:1", timestamp: new Date("2026-11-03T10:00:00.000Z"), data: "{}" })
    expect(
      statementEventCountSqlRowSchema.parse({
        events: "12",
        first_event_at: "1700000000000",
        last_event_at: 1700086400000,
        multi_component_events: "3",
      })
    ).toEqual({
      total: 12,
      firstEventAt: 1700000000000,
      lastEventAt: 1700086400000,
      multiComponentEventCount: 3,
    })
  })

  it("reads the customer of a payer budget key only", () => {
    expect(customerOfKey("unprice:customer:cus_1")).toBe("cus_1")
    expect(customerOfKey("run:abc")).toBeNull()
  })
})

describe("statement evidence queries", () => {
  function journalDatabase() {
    const db = new DatabaseSync(":memory:")
    db.exec("ATTACH DATABASE ':memory:' AS lakehouse")
    db.exec(`CREATE TABLE lakehouse.budget_journal (
      project_id TEXT, budget_key TEXT, operation_id TEXT, kind TEXT, status TEXT,
      timestamp TEXT, __ingest_ts TEXT, seq INTEGER, data TEXT
    )`)
    const read = (text: unknown, parts: readonly unknown[]): unknown => {
      if (typeof text !== "string") return null
      let value: unknown = JSON.parse(text)
      for (const part of parts) {
        if (Array.isArray(value)) value = value[Number(part)]
        else {
          const object = z.record(z.string(), z.unknown()).safeParse(value)
          if (!object.success) return null
          value = object.data[String(part)]
        }
      }
      return value ?? null
    }
    db.function("json_get_json", { varargs: true }, (text, ...parts) => {
      const value = read(text, parts)
      return value === null ? null : JSON.stringify(value)
    })
    db.function("json_get_str", { varargs: true }, (text, ...parts) => {
      const value = read(text, parts)
      return typeof value === "string" ? value : null
    })
    db.function("json_get_int", { varargs: true }, (text, ...parts) => {
      const value = read(text, parts)
      return typeof value === "number" ? value : null
    })
    db.function("json_length", (text) => {
      const value: unknown = typeof text === "string" ? JSON.parse(text) : null
      return Array.isArray(value) ? value.length : null
    })
    db.function("starts_with", (text, prefix) =>
      typeof text === "string" && typeof prefix === "string" && text.startsWith(prefix) ? 1 : 0
    )
    const insert = db.prepare(
      "INSERT INTO lakehouse.budget_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    for (const [index, kind] of ["record", "hold"].entries()) {
      const timestamp = `2026-11-03T10:0${index}:00.000Z`
      const priced = {
        at: Date.parse(timestamp),
        features: Array.from({ length: 64 }, (_, feature) => ({
          featureSlug: `f${feature}`,
          periodId: `f${feature}:bp`,
          meterQuantity: "1",
          amount: "1",
          lines: index === 0 ? [{ amount: "0.5" }, { amount: "0.5" }] : [{ amount: "1" }],
        })),
      }
      insert.run(
        "proj_1",
        "unprice:customer:cus_1",
        `o:${index}`,
        kind,
        kind === "record" ? "done" : "settled",
        timestamp,
        timestamp,
        index + 1,
        JSON.stringify(
          kind === "record"
            ? { unit: "money:USD", usage: { amount: "1" }, priced }
            : { unit: "money:EUR", state: { priced, actual: { amount: "1" } } }
        )
      )
    }
    return db
  }

  // The fixture has one version per operation, so SQLite does not need Basin's QUALIFY dedupe.
  const executableSql = (sql: string) => sql.replace(/\n {2}QUALIFY[^\n]+/, "")

  it("includes the first, ninth, and final supported feature in statement evidence", () => {
    const db = journalDatabase()
    try {
      for (const feature of [0, 8, 63]) {
        const scope = {
          projectId: "proj_1",
          customerId: "cus_1",
          periodId: `f${feature}:bp`,
          window,
        }
        const count = statementEventCountSqlRowSchema.parse(
          db.prepare(executableSql(buildStatementEventCountSql(scope))).get()
        )
        const page = db
          .prepare(executableSql(buildStatementEventsSql({ ...scope, limit: 1, offset: 1 })))
          .all()
        expect(count).toEqual({
          total: 2,
          firstEventAt: 1793700000000,
          lastEventAt: 1793700060000,
          multiComponentEventCount: 1,
        })
        expect(page.map((row) => row.operation_id)).toEqual(["o:0"])
      }
    } finally {
      db.close()
    }
  })

  it("returns empty global aggregates for a statement that received no events", () => {
    const db = journalDatabase()
    try {
      const query = buildStatementEventCountSql({
        projectId: "proj_1",
        customerId: "cus_1",
        periodId: "absent:bp",
        window,
      })
      expect(statementEventCountSqlRowSchema.parse(db.prepare(executableSql(query)).get())).toEqual(
        {
          total: 0,
          firstEventAt: null,
          lastEventAt: null,
          multiComponentEventCount: 0,
        }
      )
    } finally {
      db.close()
    }
  })

  it("keeps unlike units separate and includes every unit for the selected top payer", () => {
    const db = journalDatabase()
    try {
      const timestamp = "2026-11-03T10:00:00.000Z"
      db.prepare("INSERT INTO lakehouse.budget_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "proj_1",
        "unprice:customer:cus_2",
        "o:yen",
        "record",
        "done",
        timestamp,
        timestamp,
        1,
        JSON.stringify({ unit: "money:JPY", usage: { amount: "500" }, priced: { features: [] } })
      )
      const top = db
        .prepare(executableSql(buildTopPayersSql({ projectId: "proj_1", window, limit: 1 })))
        .all()
      expect(
        top.map((row) => ({ key: row.budget_key, unit: row.unit, amount: row.amount }))
      ).toEqual([
        { key: "unprice:customer:cus_1", unit: "money:EUR", amount: "1" },
        { key: "unprice:customer:cus_1", unit: "money:USD", amount: "1" },
      ])
      const usage = db
        .prepare(
          executableSql(
            buildFeatureUsageSql({
              projectId: "proj_1",
              customerId: "cus_1",
              window,
              byCustomer: true,
            })
          )
        )
        .all()
      expect(
        usage
          .filter((row) => row.feature_slug === "f0")
          .map((row) => ({ unit: row.unit, amount: row.amount }))
      ).toEqual([
        { unit: "money:EUR", amount: "1" },
        { unit: "money:USD", amount: "1" },
      ])
    } finally {
      db.close()
    }
  })
})
