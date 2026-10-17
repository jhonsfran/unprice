import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { sha256HexSync } from "@unprice/db/utils"
import { type BudgetConfigInput, upsertBudgetInputSchema } from "@unprice/db/validators"
import type { BudgetOutcome } from "@unprice/services/budgets"
import type { BudgetReply, BudgetRequest } from "@unprice/services/use-cases"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { afterEach, describe, expect, it } from "vitest"
import { getBudgetStub } from "~/ingestion/do-placement"
import type { BudgetDO } from "./BudgetDO"
import { BudgetSqliteStore } from "./budget-store"
import * as schema from "./db/schema"
import migrations from "./drizzle/migrations"
import { BudgetProcessor } from "./processor"

const UNIT = BigInt(100_000_000)
const units = (value: number) => BigInt(Math.round(value * 100)) * (UNIT / BigInt(100))
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

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
  return { type: "upsert", projectId: "proj_1", ...parsed }
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

/** A processor over the object's real SQLite with an injected clock and the real alarm. */
function realStorageProcessor(state: DurableObjectState, now: () => number, errors: string[] = []) {
  return new BudgetProcessor({
    clock: { now },
    logger: { error: (message, fields) => errors.push(`${message}: ${fields.error}`) },
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
  it("carries bigint across RPC, stores amounts as TEXT, and hashes keys synchronously", async () => {
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
        .exec("SELECT key_hash, data_json FROM budget_operations WHERE id = 'h_1'")
        .one() as { key_hash: string; data_json: string }
      expect(row.key_hash).toBe("f55ff16f66f43360266b95db6f8fec01d76031054306ae4a4b380598f6cfd114")
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
        state.storage.sql
          .exec("SELECT id, key_hash FROM budget_operations WHERE kind = 'charge'")
          .toArray()
      ).toEqual([{ id: `o:${sha256HexSync(longKey)}`, key_hash: sha256HexSync(longKey) }])
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
    expect([settled.covered, settled.released, settled.overrun, settled.late]).toEqual([
      units(7),
      units(3),
      BigInt(0),
      false,
    ])
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
        amount: units(45),
      }),
      "record"
    )
    expect(recorded.crossed).toEqual(["month"])
    expect(recorded.balance.remaining).toBe(-units(5))

    const denied = rejection(
      await stub.execute({ type: "charge", idempotencyKey: "c2", amount: units(1) })
    )
    expect(denied).toMatchObject({
      code: "LIMIT_EXCEEDED",
      blocked: {
        limitId: "month",
        window: "month",
        remaining: -units(5),
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

    const read = outcome(await stub.execute({ type: "get" }), "get")
    expect(read.budget.balance.remaining).toBe(-units(5))
    expect(read.budget.balance.limits[0]?.consumed).toBe(units(55))
  })

  it("refuses spend on a budget past its closesAt and reports it closed", async () => {
    const key = "customer:closed"
    const stub = stubFor(key)
    const closesAt = new Date(Date.now() - MINUTE).toISOString()
    await stub.execute(upsert(key, { ...fiftyPerMonth, closesAt }))

    expect(
      rejection(await stub.execute({ type: "authorize", idempotencyKey: "a1", amount: units(1) }))
    ).toEqual({ code: "BUDGET_CLOSED", closedAt: Date.parse(closesAt) })
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
    expect([read.budget.closesAt, read.budget.closed]).toEqual([Date.parse(closesAt), true])
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
  it("lapses a due hold, purges the tombstone, and sleeps when nothing is due", async () => {
    const key = "customer:alarm"
    const stub = stubFor(key)
    const t0 = midMonthAhead()
    let now = t0

    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const errors: string[] = []
      const processor = realStorageProcessor(state, () => now, errors)

      await processor.execute(upsert(key, fiftyPerMonth))
      await expect(state.storage.getAlarm()).resolves.toBeNull()
      await processor.execute({
        type: "authorize",
        idempotencyKey: "k1",
        amount: units(20),
        ttlMs: 1_000,
      })
      await expect(state.storage.getAlarm()).resolves.toBe(t0 + 3_000)

      // The runtime clears an alarm when it fires; the test does it by hand.
      const fire = async (at: number) => {
        now = at
        await state.storage.deleteAlarm()
        await processor.alarm()
      }
      await fire(t0 + 3_000)
      const lapsed = outcome(await processor.execute({ type: "get" }), "get")
      expect(lapsed.budget.balance.held).toBe(BigInt(0))
      await expect(state.storage.getAlarm()).resolves.toBe(t0 + 3_000 + 24 * HOUR)

      await fire(t0 + 3_000 + 24 * HOUR)
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM budget_operations").one()).toEqual({
        n: 0,
      })
      await expect(state.storage.getAlarm()).resolves.toBeNull()

      expect(
        rejection(await processor.execute({ type: "settle", holdId: "h_1", amount: units(4) }))
      ).toEqual({ code: "HOLD_RETIRED", holdId: "h_1" })
      expect(errors).toEqual([])
    })
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

  it("re-arms with a retry when the sweep throws", async () => {
    const key = "customer:alarm-retry"
    const stub = stubFor(key)
    const t0 = Date.now() + 7 * 24 * HOUR

    await runInDurableObject(stub, async (instance: BudgetDO, state) => {
      await instance.execute(upsert(key, fiftyPerMonth))
      const errors: string[] = []
      const processor = new BudgetProcessor({
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
