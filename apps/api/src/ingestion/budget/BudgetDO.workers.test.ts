import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import {
  type BudgetConfigInput,
  type BudgetOutcome,
  foldJournal,
  parseBudgetConfig,
} from "@unprice/services/budgets"
import type { BudgetReply, BudgetRequest } from "@unprice/services/use-cases"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { getBudgetStub } from "~/ingestion/do-placement"
import type { BudgetDO } from "./BudgetDO"
import { BudgetSqliteStore } from "./budget-store"
import * as schema from "./db/schema"
import { BudgetProcessor } from "./processor"

const UNIT = BigInt(100_000_000)
const units = (value: number) => BigInt(Math.round(value * 100)) * (UNIT / BigInt(100))
const HOUR = 60 * 60 * 1000

afterEach(async () => {
  await reset()
})

function stubFor(key = `customer:${crypto.randomUUID()}`) {
  return getBudgetStub(env, { projectId: "proj_1", key })
}

function upsert(key: string, config: BudgetConfigInput): BudgetRequest {
  const parsed = parseBudgetConfig(config)
  if (parsed.err) throw parsed.err
  return { type: "upsert", key, projectId: "proj_1", unit: "money:USD", config: parsed.val }
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
  it("carries bigint across RPC, stores amounts as TEXT, and hashes requests synchronously", async () => {
    const key = "customer:acme"
    const stub = stubFor(key)
    await stub.execute(upsert(key, fiftyPerMonth))

    const held = outcome(
      await stub.execute({ type: "authorize", idempotencyKey: "a1", cost: { amount: units(10) } }),
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
      expect(JSON.parse(row.data_json).requestHash).toBe(
        "0010a130db7c5aa6c952c5a775e43eb77bd05ea709301f9a317513b79e8b8468"
      )
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
      await stub.execute({ type: "authorize", idempotencyKey: "a1", cost: { amount: units(10) } }),
      "authorize"
    )
    expect(hold.holdId).toBe("h_1")

    const settled = outcome(
      await stub.execute({ type: "settle", holdId: "h_1", cost: { amount: units(7) } }),
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
      await stub.execute({ type: "charge", idempotencyKey: "c1", cost: { amount: units(3) } }),
      "charge"
    )
    expect(charged.balance.remaining).toBe(units(40))

    const recorded = outcome(
      await stub.execute({ type: "record", idempotencyKey: "r1", cost: { amount: units(45) } }),
      "record"
    )
    expect(recorded.crossed).toEqual(["month"])
    expect(recorded.balance.remaining).toBe(-units(5))

    const denied = rejection(
      await stub.execute({ type: "charge", idempotencyKey: "c2", cost: { amount: units(1) } })
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
      rejection(await stub.execute({ type: "settle", holdId: "h_99", cost: { amount: units(1) } }))
    ).toEqual({ code: "HOLD_NOT_FOUND", holdId: "h_99" })

    const read = outcome(await stub.execute({ type: "get" }), "get")
    expect(read.budget.balance.remaining).toBe(-units(5))
    expect(read.budget.balance.limits[0]?.consumed).toBe(units(55))
  })

  it("rejects every verb on a key that was never upserted", async () => {
    const stub = stubFor()
    expect(rejection(await stub.execute({ type: "get" }))).toEqual({ code: "BUDGET_NOT_FOUND" })
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
          cost: { amount: units(0.75) },
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
    const request = { type: "authorize", idempotencyKey: "k1", cost: { amount: units(5) } } as const

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

    expect(rejection(await stub.execute({ ...request, cost: { amount: units(6) } }))).toEqual({
      code: "IDEMPOTENCY_CONFLICT",
      idempotencyKey: "k1",
    })
  })

  it("keeps its state across eviction", async () => {
    const key = "customer:evict"
    const stub = stubFor(key)
    await stub.execute(upsert(key, fiftyPerMonth))
    await stub.execute({ type: "authorize", idempotencyKey: "k1", cost: { amount: units(12) } })

    await evictDurableObject(stub)

    const revived = getBudgetStub(env, { projectId: "proj_1", key })
    const replay = outcome(
      await revived.execute({
        type: "authorize",
        idempotencyKey: "k1",
        cost: { amount: units(12) },
      }),
      "authorize"
    )
    expect([replay.holdId, replay.replayed, replay.balance.held]).toEqual(["h_1", true, units(12)])
    const next = outcome(
      await revived.execute({
        type: "authorize",
        idempotencyKey: "k2",
        cost: { amount: units(1) },
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
        CREATE TRIGGER fail_hold_entry
        BEFORE INSERT ON budget_entries WHEN NEW.type = 'hold.placed'
        BEGIN
          SELECT RAISE(ABORT, 'fail after ledger write');
        END
      `)
      const request = {
        type: "authorize",
        idempotencyKey: "k1",
        cost: { amount: units(5) },
      } as const
      await expect(processor.execute(request)).rejects.toThrow("fail after ledger write")

      expect(state.storage.sql.exec("SELECT seq, hold_seq, held FROM budget_ledger").one()).toEqual(
        { seq: 1, hold_seq: 0, held: "0" }
      )
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM budget_operations").one()).toEqual({
        n: 0,
      })

      state.storage.sql.exec("DROP TRIGGER fail_hold_entry")
      expect(outcome(await processor.execute(request), "authorize").holdId).toBe("h_1")
    })
  })
})

describe("BudgetDO alarm", () => {
  it("lapses a due hold, compacts the journal, purges the tombstone, and always re-arms", async () => {
    const key = "customer:alarm"
    const stub = stubFor(key)
    // Far enough ahead that the alarms set here never fire on the real clock mid-test.
    const t0 = Date.now() + 7 * 24 * HOUR
    let now = t0

    await runInDurableObject(stub, async (instance: BudgetDO, state) => {
      await instance.execute({ type: "get" })
      await state.storage.deleteAlarm()
      const store = new BudgetSqliteStore(drizzle(state.storage, { schema, logger: false }))
      const errors: string[] = []
      const processor = realStorageProcessor(state, () => now, errors)

      await processor.execute(upsert(key, fiftyPerMonth))
      await processor.execute({
        type: "authorize",
        idempotencyKey: "k1",
        cost: { amount: units(20) },
        ttlMs: 1_000,
      })
      await expect(state.storage.getAlarm()).resolves.toBe(t0 + 3_000)

      now = t0 + 3_000
      await processor.alarm()
      const lapsed = outcome(await processor.execute({ type: "get" }), "get")
      expect(lapsed.budget.balance.held).toBe(BigInt(0))
      await expect(state.storage.getAlarm()).resolves.toBe(t0 + 24 * HOUR)

      now = t0 + 24 * HOUR + 1
      await processor.alarm()
      const compacted = store.atomically((tx) => ({
        base: tx.readJournalBase(),
        tail: tx.readJournalHead(Number.MAX_SAFE_INTEGER, 100),
        ledger: tx.readLedger(),
      }))
      expect(compacted.base.seq).toBe(2)
      expect(compacted.tail.map((entry) => [entry.seq, entry.type])).toEqual([[3, "hold.lapsed"]])
      expect(foldJournal(compacted.base, compacted.tail)).toEqual(compacted.ledger)
      await expect(state.storage.getAlarm()).resolves.toBe(t0 + 3_000 + 24 * HOUR)

      now = t0 + 3_000 + 24 * HOUR
      await processor.alarm()
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM budget_operations").one()).toEqual({
        n: 0,
      })
      await expect(state.storage.getAlarm()).resolves.toBe(now + 1_000)

      const late = outcome(
        await processor.execute({ type: "settle", holdId: "h_1", cost: { amount: units(4) } }),
        "settle"
      )
      expect([late.late, late.covered, late.overrun]).toEqual([true, BigInt(0), units(4)])
      expect(late.balance.remaining).toBe(units(46))
      expect(errors).toEqual([])
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
