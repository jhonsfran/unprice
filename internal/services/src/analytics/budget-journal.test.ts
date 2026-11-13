import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  type JournalQuery,
  customerOfKey,
  eventFacetSqlRowSchema,
  eventFacetsQuery,
  eventTimelineQuery,
  eventTotalsQuery,
  featureUsageQuery,
  featureUsageSqlRowSchema,
  parseSignedDecimal,
  recentEventSqlRowSchema,
  recentEventsQuery,
  rejectedEventQuery,
  rejectedEventSqlRowSchema,
  rejectionsQuery,
  statementEventCountQuery,
  statementEventCountSqlRowSchema,
  statementEventSqlRowSchema,
  statementEventsQuery,
  topPayersQuery,
  topPayersSqlRowSchema,
} from "./budget-journal"

const window = {
  from: new Date("2026-11-01T00:00:00.000Z"),
  to: new Date("2026-11-03T10:30:00.000Z"),
}
const scope = { projectId: "proj_1", customerId: "cus_1", window }

/** SQLite lacks QUALIFY. Keep its window ranking and apply the predicate in an outer SELECT. */
function executableSql(sql: string): string {
  return sql
    .replace(
      /latest AS \(\n {2}SELECT ([^\n]+)\n([\s\S]*?) {2}QUALIFY (ROW_NUMBER\(\) OVER \([^\n]+\)) = 1\n\)/,
      (_, columns: string, body: string, rank: string) =>
        `latest AS (\n  SELECT ${columns} FROM (\n  SELECT ${columns}, ${rank} AS journal_rank\n${body}  ) WHERE journal_rank = 1\n)`
    )
    .replace(
      /SELECT facet, value, events\nFROM facets\nQUALIFY (ROW_NUMBER\(\) OVER \([^\n]+\)) <= (\d+)/,
      (_, rank: string, limit: string) =>
        `SELECT facet, value, events FROM (SELECT facet, value, events, ${rank} AS facet_rank FROM facets) WHERE facet_rank <= ${limit}`
    )
}

function read<T>(db: DatabaseSync, query: JournalQuery<T>): T[] {
  return z.array(query.row).parse(db.prepare(executableSql(query.sql)).all())
}

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
        data: JSON.stringify({
          customerId: "c",
          idempotencyKey: "k",
          event: { slug: "tokens", properties: {} },
          rejection: { code: "LIMIT_EXCEEDED" },
        }),
      }).data
    ).toMatchObject({ idempotencyKey: "k", rejection: { code: "LIMIT_EXCEEDED" } })
    expect(
      statementEventSqlRowSchema.parse({
        operation_id: "o:1",
        timestamp: "2026-11-03T10:00:00.000Z",
        data: '{"idempotencyKey":"k","createdAt":1}',
      })
    ).toEqual({
      operation_id: "o:1",
      timestamp: new Date("2026-11-03T10:00:00.000Z"),
      data: { idempotencyKey: "k", createdAt: 1 },
    })
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
  db.function("date_trunc", (unit, value) => {
    if (typeof value !== "string") return null
    const date = new Date(value)
    date.setUTCSeconds(0, 0)
    if (unit === "hour" || unit === "day") date.setUTCMinutes(0)
    if (unit === "day") date.setUTCHours(0)
    return date.toISOString()
  })
  db.function("strpos", (text, needle) =>
    typeof text === "string" && typeof needle === "string" ? text.indexOf(needle) + 1 : 0
  )
  const insert = db.prepare(
    "INSERT INTO lakehouse.budget_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
  for (const [index, kind] of ["record", "hold"].entries()) {
    const timestamp = `2026-11-03T10:0${index}:00.000Z`
    const priced = {
      slug: "tokens",
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
      (index + 1) * 10,
      JSON.stringify(
        kind === "record"
          ? {
              idempotencyKey: `evt_${index}`,
              createdAt: Date.parse(timestamp),
              unit: "money:USD",
              usage: { amount: "1" },
              priced,
            }
          : {
              idempotencyKey: `evt_${index}`,
              createdAt: Date.parse(timestamp),
              unit: "money:EUR",
              state: { priced, actual: { amount: "1" } },
            }
      )
    )
  }
  // Export retries duplicate a version; a later write replaces earlier operation data.
  db.exec("INSERT INTO lakehouse.budget_journal SELECT * FROM lakehouse.budget_journal")
  db.exec(`INSERT INTO lakehouse.budget_journal
    SELECT project_id, budget_key, operation_id, kind, status, timestamp, __ingest_ts, seq - 1,
      json_set(data, '$.priced.features[0].amount', '9000', '$.usage.amount', '9000')
    FROM lakehouse.budget_journal WHERE kind = 'record' LIMIT 1`)
  db.exec(`INSERT INTO lakehouse.budget_journal
    SELECT project_id, budget_key, operation_id, kind, 'open', timestamp, __ingest_ts, seq - 1, data
    FROM lakehouse.budget_journal WHERE kind = 'hold' LIMIT 1`)
  return db
}

function addRefusal(db: DatabaseSync) {
  const at = "2026-11-03T10:02:00.000Z"
  db.prepare("INSERT INTO lakehouse.budget_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "proj_1",
    "unprice:customer:cus_1",
    "r:refused",
    "charge",
    "rejected",
    at,
    at,
    0,
    JSON.stringify({
      customerId: "cus_1",
      idempotencyKey: "refused",
      event: { slug: "tokens", properties: {} },
      rejection: { code: "LIMIT_EXCEEDED" },
    })
  )
}

describe("journal queries executed with window deduplication", () => {
  it("keeps the highest seq of an operation and counts retried exports once", () => {
    const db = journalDatabase()
    try {
      const features = read(db, featureUsageQuery({ ...scope, byCustomer: true }))
      expect(features.filter((row) => row.feature_slug === "f0")).toMatchObject([
        {
          budget_key: "unprice:customer:cus_1",
          unit: "money:EUR",
          events: 1,
          quantity: BigInt(100000000),
          amount: BigInt(100000000),
        },
        {
          budget_key: "unprice:customer:cus_1",
          unit: "money:USD",
          events: 1,
          quantity: BigInt(100000000),
          amount: BigInt(100000000),
        },
      ])
      expect(features.filter((row) => row.feature_slug === null).map((row) => row.events)).toEqual([
        1, 1,
      ])
      expect(read(db, topPayersQuery({ projectId: "proj_1", window, limit: 1 }))).toEqual([
        {
          budget_key: "unprice:customer:cus_1",
          unit: "money:EUR",
          events: 1,
          amount: BigInt(100000000),
        },
        {
          budget_key: "unprice:customer:cus_1",
          unit: "money:USD",
          events: 1,
          amount: BigInt(100000000),
        },
      ])
    } finally {
      db.close()
    }
  })

  it("counts the first, ninth, and final statement feature after dedupe", () => {
    const db = journalDatabase()
    try {
      for (const feature of [0, 8, 63]) {
        const statement = { ...scope, periodId: `f${feature}:bp` }
        expect(read(db, statementEventCountQuery(statement))).toEqual([
          {
            total: 2,
            firstEventAt: 1793700000000,
            lastEventAt: 1793700060000,
            multiComponentEventCount: 1,
          },
        ])
        const page = read(db, statementEventsQuery({ ...statement, limit: 1, offset: 1 }))
        expect(page.map((row) => row.operation_id)).toEqual(["o:0"])
      }
      expect(read(db, statementEventCountQuery({ ...scope, periodId: "absent:bp" }))).toEqual([
        { total: 0, firstEventAt: null, lastEventAt: null, multiComponentEventCount: 0 },
      ])
    } finally {
      db.close()
    }
  })

  it("groups event totals, minute buckets and refusals after dedupe", () => {
    const db = journalDatabase()
    try {
      addRefusal(db)
      expect(read(db, eventTotalsQuery(scope)).map((row) => [row.state, row.events])).toEqual([
        ["processed", 1],
        ["rejected", 1],
      ])
      expect(read(db, eventTimelineQuery(scope))).toEqual([
        { bucket: new Date("2026-11-03T10:02:00.000Z"), state: "rejected", events: 1 },
        { bucket: new Date("2026-11-03T10:00:00.000Z"), state: "processed", events: 1 },
      ])
      expect(read(db, rejectionsQuery({ ...scope, limit: 10 }))).toEqual([
        {
          rejection_reason: "LIMIT_EXCEEDED",
          event_slug: "tokens",
          kind: "charge",
          events: 1,
          last_seen_at: new Date("2026-11-03T10:02:00.000Z"),
        },
      ])
      expect(read(db, eventFacetsQuery({ ...scope, limit: 1 }))).toEqual([
        { facet: "budget_key", value: "unprice:customer:cus_1", events: 2 },
        { facet: "event_slug", value: "tokens", events: 2 },
        { facet: "kind", value: "charge", events: 1 },
        { facet: "rejection_reason", value: "LIMIT_EXCEEDED", events: 1 },
      ])
    } finally {
      db.close()
    }
  })

  it("pages filtered events and parses a refused payload", () => {
    const db = journalDatabase()
    try {
      addRefusal(db)
      const first = read(db, recentEventsQuery({ ...scope, limit: 1 }))[0]
      expect(first?.operation_id).toBe("r:refused")
      const page = read(
        db,
        recentEventsQuery({
          ...scope,
          limit: 2,
          cursor: {
            handledAt: 1793700120000,
            operationId: "r:refused",
            budgetKey: "unprice:customer:cus_1",
          },
        })
      )
      expect(page.map((row) => row.operation_id)).toEqual(["o:0"])
      expect(
        read(
          db,
          recentEventsQuery({
            ...scope,
            limit: 2,
            filter: { states: ["rejected"], search: "LIMIT_EXCEEDED" },
          })
        ).map((row) => row.operation_id)
      ).toEqual(["r:refused"])
      expect(
        read(
          db,
          rejectedEventQuery({
            projectId: "proj_1",
            customerId: "cus_1",
            operationId: "r:refused",
            handledAt: 1793700120000,
          })
        )[0]?.data
      ).toEqual({
        customerId: "cus_1",
        idempotencyKey: "refused",
        event: { slug: "tokens", properties: {} },
        rejection: { code: "LIMIT_EXCEEDED" },
      })
      expect(read(db, featureUsageQuery({ ...scope, projectId: "other'project" }))).toEqual([])
      expect(read(db, featureUsageQuery({ ...scope, customerId: "other'customer" }))).toEqual([])
    } finally {
      db.close()
    }
  })

  it("keeps operations with the same id in different budgets separate", () => {
    const db = journalDatabase()
    try {
      db.exec(
        `INSERT INTO lakehouse.budget_journal SELECT project_id, 'unprice:customer:cus_2', operation_id, kind, status, timestamp, __ingest_ts, seq, data FROM lakehouse.budget_journal WHERE kind = 'record' AND seq = 10 LIMIT 1`
      )
      expect(
        read(db, eventTotalsQuery({ projectId: "proj_1", window })).map((row) => row.events)
      ).toEqual([2])
    } finally {
      db.close()
    }
  })
})
