import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test"
import { env } from "cloudflare:workers"
import { sha256HexSync } from "@unprice/db/utils"
import { type BudgetConfigInput, upsertBudgetInputSchema } from "@unprice/db/validators"
import {
  type BudgetOutcome,
  CLOSED_BUDGET_RETENTION_MS,
  EXPIRED_PER_SWEEP,
} from "@unprice/services/budgets"
import type { BudgetReply, BudgetRequest } from "@unprice/services/use-cases"
import { and, asc, eq, lte, min, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { afterEach, describe, expect, it } from "vitest"
import { getBudgetStub } from "~/ingestion/do-placement"
import type { BudgetDO } from "./BudgetDO"
import { BudgetSqliteStore } from "./budget-store"
import * as schema from "./db/schema"
import migrations from "./drizzle/migrations"
import { ALARM_CONTINUE_MS, BudgetProcessor } from "./processor"

const UNIT = BigInt(100_000_000)
const units = (value: number) => BigInt(Math.round(value * 100)) * (UNIT / BigInt(100))
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 12:30 UTC on the 10th of next month: far enough that real alarms never fire mid-test, and far
 * from any day, week-of-month, or month boundary an alarm could wake for first.
 */
function midMonthAhead() {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 10, 12, 30)
}

afterEach(async () => {
  await reset()
})

function stubFor(key = `customer:${crypto.randomUUID()}`) {
  return getBudgetStub(env, { projectId: "proj_1", key })
}

function upsert(key: string, config: BudgetConfigInput): BudgetRequest {
  const parsed = upsertBudgetInputSchema.parse({ key, unit: "USD", ...config })
  return { type: "upsert", projectId: "proj_1", ...parsed, mayLoosen: true }
}

const fiftyPerMonth: BudgetConfigInput = {
  limits: [{ id: "month", amount: "50", window: "month" }],
}

function outcome<T extends BudgetOutcome["type"]>(reply: BudgetReply, type: T) {
  if (!reply.ok) throw new Error(`expected ${type}, got ${reply.rejection.code}`)
  const value = reply.outcome
  if (value.type !== type) throw new Error(`expected ${type}, got ${value.type}`)
  return value as BudgetOutcome & { type: T }
}

/**
 * A processor over the object's real SQLite with an injected clock and the real alarm. Deleting a
 * closed budget wipes the storage as BudgetDO does and records when it happened in `destroyed`.
 */
function realStorageProcessor(
  state: DurableObjectState,
  now: () => number,
  errors: string[] = [],
  destroyed: number[] = []
) {
  return new BudgetProcessor({
    clock: { now },
    logger: { error: (message, fields) => errors.push(`${message}: ${fields.error}`) },
    runtime: {
      destroy: async () => {
        await state.storage.deleteAlarm()
        await state.storage.deleteAll()
        destroyed.push(now())
      },
    },
    scheduler: {
      getAlarm: () => state.storage.getAlarm(),
      setAlarm: (at) => state.storage.setAlarm(at),
    },
    store: new BudgetSqliteStore(drizzle(state.storage, { schema, logger: false })),
  })
}

function rejection(reply: BudgetReply) {
  if (reply.ok) throw new Error(`expected a rejection, got ${reply.outcome.type}`)
  return reply.rejection
}

describe("BudgetDO runtime assumptions", () => {
  it("carries bigint across RPC and stores exact decimal amounts", async () => {
    const key = "customer:acme"
    const stub = stubFor(key)
    await stub.execute(upsert(key, fiftyPerMonth))

    const held = outcome(
      await stub.execute({ type: "authorize", idempotencyKey: "a1", amount: units(10) }),
      "authorize"
    )
    expect(held.amount).toBe(BigInt(1_000_000_000))
    expect(held.balance.remaining).toBe(BigInt(4_000_000_000))

    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      expect(
        state.storage.sql.exec("SELECT held, typeof(held) AS type FROM budget_ledger").one()
      ).toEqual({ held: "1000000000", type: "text" })
      const row = state.storage.sql
        .exec("SELECT data_json FROM budget_operations WHERE id = 'h_1'")
        .one() as { data_json: string }
      expect(JSON.parse(row.data_json)).toMatchObject({
        idempotencyKey: "a1",
        amount: { $bigint: "1000000000" },
        ttlMs: null,
      })
    })
  })

  it("keys a charge row by its key's hash, so a long key never becomes the primary key", async () => {
    const key = "customer:long-keys"
    const stub = stubFor(key)
    await stub.execute(upsert(key, fiftyPerMonth))
    const longKey = "k".repeat(256)
    const charge: BudgetRequest = { type: "charge", idempotencyKey: longKey, amount: units(1) }

    expect(outcome(await stub.execute(charge), "charge").replayed).toBe(false)
    expect(outcome(await stub.execute(charge), "charge").replayed).toBe(true)

    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      expect(
        state.storage.sql.exec("SELECT id FROM budget_operations WHERE kind = 'charge'").toArray()
      ).toEqual([{ id: `o:${sha256HexSync(longKey)}` }])
    })
  })

  it("gives open holds stored before expiry settlement their expiry as due time", async () => {
    const stub = stubFor()
    const expiresAt = midMonthAhead()
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      const db = drizzle(state.storage)
      const entries = migrations.journal.entries.filter((entry) => entry.idx < 2)
      await migrate(db, { ...migrations, journal: { ...migrations.journal, entries } })
      const hold = { idempotencyKey: "legacy", amount: { $bigint: "1" }, ttlMs: null, expiresAt }
      state.storage.sql.exec(
        "INSERT INTO budget_operations (id, kind, status, due_at, data_json) VALUES ('h_1', 'hold', 'open', 0, ?)",
        JSON.stringify({ ...hold, createdAt: expiresAt - MINUTE, state: { status: "open" } })
      )

      await migrate(db, migrations)

      expect(state.storage.sql.exec("SELECT due_at FROM budget_operations").one()).toEqual({
        due_at: expiresAt,
      })
    })
  })

  it("finds a row by key, the next due row, and expired holds through their indexes", async () => {
    const key = "customer:indexes"
    const stub = stubFor(key)
    await stub.execute(upsert(key, fiftyPerMonth))

    await runInDurableObject(stub, (_instance: BudgetDO, state) => {
      // The same queries the store builds, so the plan covers the SQL drizzle renders.
      const db = drizzle(state.storage, { schema, logger: false })
      const operations = schema.budgetOperations
      const terminal = sql`${operations.status} IN ('done', 'settled', 'released')`
      const plan = ({ sql: query, params }: { sql: string; params: unknown[] }) =>
        state.storage.sql
          .exec(`EXPLAIN QUERY PLAN ${query}`, ...params)
          .toArray()
          .map((row) => String(row.detail))
          .join("; ")

      // A hold by its key needs the literal `kind = 'hold'` to match the partial index; a charge or
      // record is read by its id.
      const holdByKey = db
        .select({ dataJson: operations.dataJson })
        .from(operations)
        .where(
          sql`${operations.kind} = 'hold' AND ${operations.dataJson} ->> '$.idempotencyKey' = ${"k"}`
        )
      expect(plan(holdByKey.toSQL())).toContain("USING INDEX budget_operations_hold_key_idx")
      const byId = db
        .select({ dataJson: operations.dataJson })
        .from(operations)
        .where(eq(operations.id, "o:hash"))
      expect(plan(byId.toSQL())).toMatch(/USING INDEX sqlite_autoindex_budget_operations_1/)
      const due = db
        .select({ id: operations.id })
        .from(operations)
        .where(and(terminal, lte(operations.dueAt, 0)))
        .orderBy(asc(operations.dueAt))
        .limit(2048)
      const next = db.select({ at: min(operations.dueAt) }).from(operations)
      const expired = db
        .select({ id: operations.id })
        .from(operations)
        .where(and(eq(operations.status, "open"), lte(operations.dueAt, 0)))
        .orderBy(asc(operations.dueAt), asc(sql`length(${operations.id})`), asc(operations.id))
        .limit(256)
      for (const query of [due, next, expired]) {
        expect(plan(query.toSQL())).toMatch(/USING (COVERING )?INDEX budget_operations_due_idx/)
      }
    })
  })
})

describe("BudgetDO verbs", () => {
  it("runs every verb against one budget end to end", async () => {
    const key = "customer:verbs"
    const stub = stubFor(key)

    const created = outcome(await stub.execute(upsert(key, fiftyPerMonth)), "upsert")
    expect(created.changes).toEqual([{ change: "limit.added", limitId: "month" }])
    expect(created.budget.version).toBe(1)

    const hold = outcome(
      await stub.execute({ type: "authorize", idempotencyKey: "a1", amount: units(10) }),
      "authorize"
    )
    expect(hold.holdId).toBe("h_1")

    const settled = outcome(
      await stub.execute({ type: "settle", holdId: "h_1", amount: units(7) }),
      "settle"
    )
    expect([settled.actual, settled.released]).toEqual([units(7), units(3)])
    expect(settled.balance.remaining).toBe(units(43))

    const charged = outcome(
      await stub.execute({ type: "charge", idempotencyKey: "c1", amount: units(3) }),
      "charge"
    )
    expect(charged.balance.remaining).toBe(units(40))

    const recorded = outcome(
      await stub.execute({
        type: "record",
        idempotencyKey: "r1",
        occurredAt: Date.now(),
        amount: units(40),
      }),
      "record"
    )
    expect(recorded.crossed).toEqual([])
    expect(recorded.balance.remaining).toBe(BigInt(0))

    const denied = rejection(
      await stub.execute({ type: "charge", idempotencyKey: "c2", amount: units(1) })
    )
    expect(denied).toMatchObject({
      code: "LIMIT_EXCEEDED",
      blocked: {
        limitId: "month",
        window: "month",
        remaining: BigInt(0),
        remedy: "wait_for_reset",
      },
    })

    expect(rejection(await stub.execute({ type: "release", holdId: "h_1" }))).toEqual({
      code: "HOLD_CLOSED",
      holdId: "h_1",
      status: "settled",
    })
    expect(
      rejection(await stub.execute({ type: "settle", holdId: "h_99", amount: units(1) }))
    ).toEqual({ code: "HOLD_NOT_FOUND", holdId: "h_99" })

    // A charge or record key and a hold key are one namespace, through the id and the hold index.
    expect(
      rejection(
        await stub.execute({
          type: "record",
          idempotencyKey: "a1",
          occurredAt: Date.now(),
          amount: units(1),
        })
      )
    ).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })
    expect(
      rejection(await stub.execute({ type: "authorize", idempotencyKey: "c1", amount: units(1) }))
    ).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })

    const read = outcome(await stub.execute({ type: "get" }), "get")
    expect(read.budget.balance.remaining).toBe(BigInt(0))
    expect(read.budget.balance.limits[0]?.consumed).toBe(units(50))
    expect(read.budget.operations).toEqual({
      upsert: 1,
      authorize: 1,
      settle: 1,
      release: 0,
      charge: 1,
      record: 1,
      lease: 0,
      report: 0,
    })
  })

  it("grants, reports on, and closes a lease end to end, keyed by its key's hash", async () => {
    const key = "customer:lease"
    const stub = stubFor(key)
    await stub.execute(upsert(key, fiftyPerMonth))

    const granted = outcome(
      await stub.execute({ type: "lease", leaseKey: "proc-1", amount: units(20), ttlMs: MINUTE }),
      "lease"
    )
    expect(granted.lease).toEqual({
      leaseKey: "proc-1",
      seq: 0,
      granted: units(20),
      captured: BigInt(0),
      expiresAt: granted.balance.asOf + MINUTE,
      status: "open",
    })
    expect([granted.balance.remaining, granted.balance.held]).toEqual([units(30), units(20)])

    const reported = outcome(
      await stub.execute({
        type: "report",
        leaseKey: "proc-1",
        seq: 1,
        request: { final: false, captured: units(5), extend: units(40) },
      }),
      "report"
    )
    expect([reported.lease.granted, reported.lease.captured, reported.extension]).toEqual([
      units(50),
      units(5),
      {
        requested: units(40),
        granted: units(30),
        denied: {
          code: "LIMIT_EXCEEDED",
          blocked: {
            limitId: "month",
            window: "month",
            remaining: units(30),
            held: units(15),
            resetsAt: reported.balance.limits[0]?.resetsAt,
            remedy: "release_holds",
          },
        },
      },
    ])

    const final: BudgetRequest = {
      type: "report",
      leaseKey: "proc-1",
      seq: 2,
      request: { final: true, captured: units(12) },
    }
    const closed = outcome(await stub.execute(final), "report")
    expect([closed.lease.status, closed.released, closed.balance.remaining]).toEqual([
      "closed",
      units(38),
      units(38),
    ])
    expect(outcome(await stub.execute(final), "report").replayed).toBe(true)
    expect(
      rejection(
        await stub.execute({
          type: "report",
          leaseKey: "proc-2",
          seq: 1,
          request: { final: true, captured: BigInt(0) },
        })
      )
    ).toEqual({ code: "LEASE_NOT_FOUND", leaseKey: "proc-2" })
    // A lease key and an idempotency key are separate namespaces.
    expect(
      outcome(
        await stub.execute({ type: "charge", idempotencyKey: "proc-1", amount: units(1) }),
        "charge"
      ).replayed
    ).toBe(false)

    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      expect(
        state.storage.sql
          .exec("SELECT id, status FROM budget_operations WHERE kind = 'lease'")
          .toArray()
      ).toEqual([{ id: `l:${sha256HexSync("proc-1")}`, status: "done" }])
    })
    const read = outcome(await stub.execute({ type: "get" }), "get")
    expect([read.budget.balance.held, read.budget.operations]).toEqual([
      BigInt(0),
      { upsert: 1, authorize: 0, settle: 0, release: 0, charge: 1, record: 0, lease: 1, report: 2 },
    ])
  })

  it("refuses spend on a budget past its closesAt and reports it closed", async () => {
    const key = "customer:closed"
    const stub = stubFor(key)
    const closesAt = Date.now() - MINUTE
    await stub.execute(upsert(key, { ...fiftyPerMonth, closesAt }))

    expect(
      rejection(await stub.execute({ type: "authorize", idempotencyKey: "a1", amount: units(1) }))
    ).toEqual({ code: "BUDGET_CLOSED", closedAt: closesAt })
    const recorded = outcome(
      await stub.execute({
        type: "record",
        idempotencyKey: "r1",
        occurredAt: Date.now(),
        amount: units(2),
      }),
      "record"
    )
    expect(recorded.balance.remaining).toBe(units(48))
    const read = outcome(await stub.execute({ type: "get" }), "get")
    expect([read.budget.closesAt, read.budget.closed]).toEqual([closesAt, true])
  })

  it("rejects every verb on a key that was never upserted and stores nothing for it", async () => {
    const stub = stubFor()
    expect(rejection(await stub.execute({ type: "get" }))).toEqual({ code: "BUDGET_NOT_FOUND" })
    expect(
      rejection(await stub.execute({ type: "settle", holdId: "h_1", amount: units(1) }))
    ).toEqual({ code: "BUDGET_NOT_FOUND" })

    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .filter(({ name }) => !name.startsWith("_cf_"))
      expect([tables, await state.storage.getAlarm()]).toEqual([[], null])
    })
  })

  it("never lets 100 parallel authorizes exceed a $50 cap", async () => {
    const key = "customer:race"
    const stub = stubFor(key)
    await stub.execute(upsert(key, fiftyPerMonth))

    const replies = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        stub.execute({
          type: "authorize",
          idempotencyKey: `race-${index}`,
          amount: units(0.75),
        })
      )
    )

    expect(replies.filter((reply) => reply.ok)).toHaveLength(66)
    expect(
      replies.filter((reply) => !reply.ok && reply.rejection.code === "LIMIT_EXCEEDED")
    ).toHaveLength(34)
    const read = outcome(await stub.execute({ type: "get" }), "get")
    expect(read.budget.balance.held).toBe(units(49.5))
    expect(read.budget.balance.remaining).toBe(units(0.5))
  })

  it("replays a retried request and rejects a changed payload under the same key", async () => {
    const key = "customer:replay"
    const stub = stubFor(key)
    await stub.execute(upsert(key, fiftyPerMonth))
    const request = { type: "authorize", idempotencyKey: "k1", amount: units(5) } as const

    const first = outcome(await stub.execute(request), "authorize")
    const retry = outcome(await stub.execute(request), "authorize")
    expect([first.holdId, first.replayed]).toEqual(["h_1", false])
    expect([retry.holdId, retry.amount, retry.expiresAt, retry.replayed]).toEqual([
      "h_1",
      units(5),
      first.expiresAt,
      true,
    ])
    expect(retry.balance.held).toBe(units(5))

    expect(rejection(await stub.execute({ ...request, amount: units(6) }))).toEqual({
      code: "IDEMPOTENCY_CONFLICT",
      idempotencyKey: "k1",
    })
  })

  it("keeps its state across eviction", async () => {
    const key = "customer:evict"
    const stub = stubFor(key)
    await stub.execute(upsert(key, fiftyPerMonth))
    await stub.execute({ type: "authorize", idempotencyKey: "k1", amount: units(12) })

    await evictDurableObject(stub)

    const revived = getBudgetStub(env, { projectId: "proj_1", key })
    const replay = outcome(
      await revived.execute({
        type: "authorize",
        idempotencyKey: "k1",
        amount: units(12),
      }),
      "authorize"
    )
    expect([replay.holdId, replay.replayed, replay.balance.held]).toEqual(["h_1", true, units(12)])
    const next = outcome(
      await revived.execute({
        type: "authorize",
        idempotencyKey: "k2",
        amount: units(1),
      }),
      "authorize"
    )
    expect(next.holdId).toBe("h_2")
  })

  it("rolls back the ledger when a later write in the same command fails", async () => {
    const key = "customer:rollback"
    const stub = stubFor(key)
    await stub.execute(upsert(key, fiftyPerMonth))

    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      const processor = realStorageProcessor(state, () => Date.now())
      state.storage.sql.exec(`
        CREATE TRIGGER fail_hold_row
        BEFORE INSERT ON budget_operations WHEN NEW.kind = 'hold'
        BEGIN
          SELECT RAISE(ABORT, 'fail after ledger write');
        END
      `)
      const request = {
        type: "authorize",
        idempotencyKey: "k1",
        amount: units(5),
      } as const
      await expect(processor.execute(request)).rejects.toThrow("fail after ledger write")

      expect(state.storage.sql.exec("SELECT hold_seq, held FROM budget_ledger").one()).toEqual({
        hold_seq: 0,
        held: "0",
      })
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM budget_operations").one()).toEqual({
        n: 0,
      })

      state.storage.sql.exec("DROP TRIGGER fail_hold_row")
      expect(outcome(await processor.execute(request), "authorize").holdId).toBe("h_1")
    })
  })
})

describe("BudgetDO alarm", () => {
  it("settles an expired hold at its full amount when its alarm fires", async () => {
    const key = "customer:uncertain"
    const stub = stubFor(key)
    const t0 = midMonthAhead()
    let now = t0
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const processor = realStorageProcessor(state, () => now)
      await processor.execute(upsert(key, { limits: [{ id: "cap", amount: "50", window: "day" }] }))
      await processor.execute({
        type: "authorize",
        idempotencyKey: "unknown-provider-result",
        amount: units(40),
        ttlMs: 1_000,
      })
      await expect(state.storage.getAlarm()).resolves.toBe(t0 + 1_000)
      now += 2 * 24 * HOUR
      await processor.alarm()
      expect(state.storage.sql.exec("SELECT held FROM budget_ledger").one()).toEqual({ held: "0" })
      expect(
        state.storage.sql.exec("SELECT status, due_at FROM budget_operations").toArray()
      ).toEqual([{ status: "settled", due_at: now + 24 * HOUR }])
      expect(
        rejection(
          await processor.execute({
            type: "charge",
            idempotencyKey: "competitor",
            amount: units(11),
          })
        ).code
      ).toBe("LIMIT_EXCEEDED")
      expect(
        rejection(await processor.execute({ type: "settle", holdId: "h_1", amount: units(35) }))
      ).toEqual({ code: "HOLD_CLOSED", holdId: "h_1", status: "expired" })
      const final = outcome(
        await processor.execute({ type: "settle", holdId: "h_1", amount: units(40) }),
        "settle"
      )
      expect([final.expired, final.replayed, final.actual, final.balance.remaining]).toEqual([
        true,
        true,
        units(40),
        units(10),
      ])
      await expect(state.storage.getAlarm()).resolves.toBe(now + 24 * HOUR)
      now += 24 * HOUR
      await processor.alarm()
      expect(
        rejection(await processor.execute({ type: "settle", holdId: "h_1", amount: units(35) }))
          .code
      ).toBe("HOLD_RETIRED")
    })
    await evictDurableObject(stub)
    const read = outcome(await stub.execute({ type: "get" }), "get")
    expect(read.budget.balance.held).toBe(BigInt(0))
  })

  it("expires an unreported lease into consumption of its whole grant when its alarm fires", async () => {
    const key = "customer:lease-expiry"
    const stub = stubFor(key)
    const t0 = midMonthAhead()
    let now = t0
    const report = (seq: number, captured: number): BudgetRequest => ({
      type: "report",
      leaseKey: "proc-1",
      seq,
      request: { final: false, captured: units(captured), extend: BigInt(0) },
    })
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const processor = realStorageProcessor(state, () => now)
      await processor.execute(upsert(key, { limits: [{ id: "cap", amount: "50", window: "day" }] }))
      outcome(
        await processor.execute({
          type: "lease",
          leaseKey: "proc-1",
          amount: units(40),
          ttlMs: 10_000,
        }),
        "lease"
      )
      await expect(state.storage.getAlarm()).resolves.toBe(t0 + 10_000)

      now = t0 + 1_000
      expect(outcome(await processor.execute(report(1, 10)), "report").lease.expiresAt).toBe(
        t0 + 10_000
      )
      now = t0 + 7_000
      expect(outcome(await processor.execute(report(2, 15)), "report").lease.expiresAt).toBe(
        t0 + 17_000
      )
      // The renewal left the earlier alarm armed; its wake finds nothing due and re-arms.
      now = t0 + 10_000
      await processor.alarm()
      await expect(state.storage.getAlarm()).resolves.toBe(t0 + 17_000)

      now = t0 + 20_000
      await processor.alarm()
      expect(state.storage.sql.exec("SELECT held FROM budget_ledger").one()).toEqual({ held: "0" })
      expect(
        state.storage.sql.exec("SELECT status, due_at FROM budget_operations").toArray()
      ).toEqual([{ status: "done", due_at: now + DAY }])
      const read = outcome(await processor.execute({ type: "get" }), "get")
      expect([read.budget.balance.remaining, read.budget.balance.limits[0]?.consumed]).toEqual([
        units(10),
        units(40),
      ])
      expect(
        rejection(
          await processor.execute({
            type: "report",
            leaseKey: "proc-1",
            seq: 3,
            request: { final: true, captured: units(20) },
          })
        )
      ).toEqual({ code: "LEASE_CLOSED", leaseKey: "proc-1", status: "expired" })

      now += DAY
      await processor.alarm()
      expect(rejection(await processor.execute(report(3, 20))).code).toBe("LEASE_NOT_FOUND")
      expect(
        outcome(
          await processor.execute({
            type: "charge",
            idempotencyKey: "next-day",
            amount: units(50),
          }),
          "charge"
        ).balance.remaining
      ).toBe(BigInt(0))
    })
  })

  it("settles expired holds in batches, and the next day has the capacity back", async () => {
    const key = "customer:many-uncertain"
    const stub = stubFor(key)
    const holds = EXPIRED_PER_SWEEP + 44
    let now = midMonthAhead()
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const processor = realStorageProcessor(state, () => now)
      await processor.execute(
        upsert(key, { limits: [{ id: "cap", amount: String(holds), window: "day" }] })
      )
      for (let i = 0; i < holds; i++) {
        outcome(
          await processor.execute({
            type: "authorize",
            idempotencyKey: `hold-${i}`,
            amount: units(1),
            ttlMs: 1_000,
          }),
          "authorize"
        )
      }
      now += HOUR
      await processor.alarm()
      // A full batch leaves expired holds behind, so the alarm comes straight back for them.
      await expect(state.storage.getAlarm()).resolves.toBe(now + ALARM_CONTINUE_MS)
      expect(outcome(await processor.execute({ type: "get" }), "get").budget.balance.held).toBe(
        units(44)
      )
      now += ALARM_CONTINUE_MS
      await processor.alarm()
    })
    await evictDurableObject(stub)
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      const processor = realStorageProcessor(state, () => now)
      const request = { type: "authorize", idempotencyKey: "next", amount: units(1) } as const
      expect(rejection(await processor.execute(request))).toMatchObject({
        code: "LIMIT_EXCEEDED",
        blocked: { limitId: "cap", remedy: "wait_for_reset" },
      })
      const balance = outcome(await processor.execute({ type: "get" }), "get").budget.balance
      expect([balance.held, balance.limits[0]?.consumed]).toEqual([BigInt(0), units(holds)])
      now += 24 * HOUR
      expect(outcome(await processor.execute(request), "authorize").balance.remaining).toBe(
        units(holds - 1)
      )
    })
  })

  it("deletes a closed budget thirty days after it closes, once its last row is gone", async () => {
    const key = "customer:closing"
    const stub = stubFor(key)
    const t0 = midMonthAhead()
    const closesAt = t0 + HOUR
    const deletable = closesAt + CLOSED_BUDGET_RETENTION_MS
    const destroyed: number[] = []
    let now = t0

    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const processor = realStorageProcessor(state, () => now, [], destroyed)
      await processor.execute(upsert(key, { ...fiftyPerMonth, closesAt }))
      await expect(state.storage.getAlarm()).resolves.toBe(deletable)

      // A record still accepted after the close keeps its row for 8 days, well inside the 30.
      now = closesAt + MINUTE
      const late = {
        type: "record",
        idempotencyKey: "late",
        occurredAt: closesAt,
        amount: units(1),
      } as const
      outcome(await processor.execute(late), "record")
      await expect(state.storage.getAlarm()).resolves.toBe(now + 8 * DAY)
      now += 8 * DAY
      await processor.alarm()
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM budget_operations").one()).toEqual({
        n: 0,
      })
      await expect(state.storage.getAlarm()).resolves.toBe(deletable)

      now = deletable - 1
      await processor.alarm()
      expect(destroyed).toEqual([])
      now = deletable
      await processor.alarm()
      expect(destroyed).toEqual([deletable])
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })
    await evictDurableObject(stub)
    expect(rejection(await stub.execute({ type: "get" }))).toEqual({ code: "BUDGET_NOT_FOUND" })
  })

  it("answers a deleted budget as never created, and an upsert starts it over", async () => {
    const key = "customer:closed-long-ago"
    const stub = stubFor(key)
    const closesAt = Date.now() - CLOSED_BUDGET_RETENTION_MS - MINUTE
    outcome(await stub.execute(upsert(key, { ...fiftyPerMonth, closesAt })), "upsert")

    // Its deletion was already due, so the alarm may have run on its own; this runs it otherwise.
    await runDurableObjectAlarm(stub)

    expect(rejection(await stub.execute({ type: "get" }))).toEqual({ code: "BUDGET_NOT_FOUND" })
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await expect(state.storage.getAlarm()).resolves.toBeNull()
      expect(
        state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'budget'").toArray()
      ).toEqual([])
    })
    const recreated = outcome(await stub.execute(upsert(key, fiftyPerMonth)), "upsert")
    expect([recreated.budget.version, recreated.budget.closesAt]).toEqual([1, null])
  })

  it("rolls a period into history on the next command and keeps twelve per window", async () => {
    const key = "customer:roll"
    const stub = stubFor(key)
    const t0 = midMonthAhead()
    const boundary = t0 + 30 * MINUTE
    let now = t0

    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const processor = realStorageProcessor(state, () => now)
      const hourly = (window_id: string) =>
        state.storage.sql
          .exec(
            "SELECT window_id, start, end, consumed FROM budget_window_history WHERE window_id = ? ORDER BY start DESC",
            window_id
          )
          .toArray()

      await processor.execute(
        upsert(key, { limits: [{ id: "hourly", amount: "10", window: "hour" }] })
      )
      // No wake at the boundary: a counter rolls on the next command however late it comes.
      await expect(state.storage.getAlarm()).resolves.toBeNull()
      await processor.execute({ type: "charge", idempotencyKey: "c0", amount: units(4) })

      now = boundary + 5 * MINUTE
      const read = outcome(await processor.execute({ type: "get" }), "get")
      expect(read.history).toEqual([
        { windowId: "hour", start: boundary - HOUR, end: boundary, consumed: units(4) },
      ])
      expect(read.budget.balance.limits[0]?.consumed).toBe(BigInt(0))
      expect(hourly("hour")).toEqual([
        { window_id: "hour", start: boundary - HOUR, end: boundary, consumed: "400000000" },
      ])

      for (let i = 1; i <= 13; i++) {
        now = boundary + i * HOUR
        await processor.execute({
          type: "charge",
          idempotencyKey: `c${i}`,
          amount: units(1),
        })
      }
      // Thirteen periods rolled with usage (the empty one at `boundary` never rolls); the oldest went.
      const kept = hourly("hour")
      expect([kept.length, kept[0]?.start, kept[11]?.start]).toEqual([
        12,
        boundary + 12 * HOUR,
        boundary + HOUR,
      ])
    })
  })

  it("keeps a record's row through alarms for 8 days, conflicts included", async () => {
    const key = "customer:record-replay"
    const stub = stubFor(key)
    const t0 = midMonthAhead()
    let now = t0

    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const processor = realStorageProcessor(state, () => now)
      await processor.execute(
        upsert(key, { limits: [{ id: "life", amount: "50", window: "never" }] })
      )
      const request = {
        type: "record",
        idempotencyKey: "evt_1",
        occurredAt: t0,
        amount: units(4),
      } as const
      expect(outcome(await processor.execute(request), "record").replayed).toBe(false)
      const rows = () => state.storage.sql.exec("SELECT count(*) AS n FROM budget_operations").one()

      now = t0 + 25 * HOUR
      await processor.alarm()
      expect(rows()).toEqual({ n: 1 })
      const replay = outcome(await processor.execute({ ...request, occurredAt: t0 + 1 }), "record")
      expect([replay.replayed, replay.amount, replay.balance.remaining]).toEqual([
        true,
        units(4),
        units(46),
      ])
      expect(rejection(await processor.execute({ ...request, amount: units(5) }))).toEqual({
        code: "IDEMPOTENCY_CONFLICT",
        idempotencyKey: "evt_1",
      })

      now = t0 + 8 * 24 * HOUR
      await processor.alarm()
      expect(rows()).toEqual({ n: 0 })
      expect(rejection(await processor.execute(request)).code).toBe("TOO_LATE")
    })
  })

  it("propagates a failed attempt to re-arm after a sweep error", async () => {
    const errors: string[] = []
    const processor = new BudgetProcessor({
      runtime: { destroy: async () => {} },
      clock: { now: () => Date.now() },
      logger: { error: (message) => errors.push(message) },
      scheduler: {
        getAlarm: async () => null,
        setAlarm: async () => {
          throw new Error("alarm unavailable")
        },
      },
      store: {
        atomically: () => {
          throw new Error("storage unavailable")
        },
      },
    })
    await expect(processor.alarm()).rejects.toThrow("alarm unavailable")
    expect(errors).toEqual(["budget alarm failed", "budget alarm could not re-arm"])
  })

  it("re-arms with a retry when the sweep throws", async () => {
    const key = "customer:alarm-retry"
    const stub = stubFor(key)
    const t0 = Date.now() + 7 * 24 * HOUR

    await runInDurableObject(stub, async (instance: BudgetDO, state) => {
      await instance.execute(upsert(key, fiftyPerMonth))
      const errors: string[] = []
      const processor = new BudgetProcessor({
        runtime: { destroy: async () => {} },
        clock: { now: () => t0 },
        logger: { error: (message, fields) => errors.push(`${message}: ${fields.error}`) },
        scheduler: {
          getAlarm: () => state.storage.getAlarm(),
          setAlarm: (at) => state.storage.setAlarm(at),
        },
        store: {
          atomically: () => {
            throw new Error("storage unavailable")
          },
        },
      })

      await processor.alarm()

      expect(errors).toEqual(["budget alarm failed: storage unavailable"])
      await expect(state.storage.getAlarm()).resolves.toBe(t0 + 30_000)
    })
  })
})
