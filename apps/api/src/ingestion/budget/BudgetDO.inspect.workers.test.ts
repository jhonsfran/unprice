import { reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { type BudgetConfigInput, upsertBudgetInputSchema } from "@unprice/db/validators"
import {
  type BudgetInspectQuery,
  type BudgetInspectReply,
  INSPECT_SCAN_LIMIT,
} from "@unprice/services/budgets"
import type { BudgetRequest } from "@unprice/services/use-cases"
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
const DAY = 24 * HOUR

afterEach(async () => {
  await reset()
})

function midMonthAhead() {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 10, 12, 30)
}

function stubFor(key = `customer:${crypto.randomUUID()}`) {
  return getBudgetStub(env, { projectId: "proj_1", key })
}

function upsert(key: string, config: BudgetConfigInput): BudgetRequest {
  const parsed = upsertBudgetInputSchema.parse({ key, unit: "USD", ...config })
  return { type: "upsert", projectId: "proj_1", ...parsed, mayLoosen: true }
}

function inspection(reply: BudgetInspectReply) {
  if (!reply.ok) throw new Error(`expected an inspection, got ${reply.rejection.code}`)
  return reply.inspection
}

/** A processor over the object's real SQLite with an injected clock. */
async function clockedProcessor(state: DurableObjectState, now: () => number) {
  await migrate(drizzle(state.storage), migrations)
  return new BudgetProcessor({
    clock: { now },
    logger: { error: () => {} },
    runtime: { destroy: async () => {} },
    scheduler: {
      getAlarm: () => state.storage.getAlarm(),
      setAlarm: (at) => state.storage.setAlarm(at),
    },
    store: new BudgetSqliteStore(drizzle(state.storage, { schema, logger: false })),
  })
}

const roomy: BudgetConfigInput = {
  limits: [{ id: "month", amount: "1000000", window: "month" }],
}

describe("BudgetDO.inspect", () => {
  it("lists every open hold and lease and their sum equals held when one scan covers them", async () => {
    const key = "customer:listed"
    const stub = stubFor(key)
    await stub.execute(upsert(key, roomy))
    for (const [idempotencyKey, amount] of [
      ["a1", 10],
      ["a2", 4],
      ["a3", 7],
    ] as const) {
      await stub.execute({ type: "authorize", idempotencyKey, amount: units(amount) })
    }
    await stub.execute({ type: "settle", holdId: "h_2", amount: units(3) })
    await stub.execute({ type: "lease", leaseKey: "proc-1", amount: units(20), ttlMs: MINUTE })
    await stub.execute({
      type: "report",
      leaseKey: "proc-1",
      seq: 1,
      request: { final: false, captured: units(5), extend: BigInt(0) },
    })

    const read = inspection(await stub.inspect({}))

    expect(read.budget.balance.held).toBe(units(10 + 7 + 15))
    expect(read.listed).toBe(read.budget.balance.held)
    expect(read.expiringNext.rows.map((row) => row.id).sort()).toEqual(["h_1", "h_3", "l:proc-1"])
    expect([read.expiringNext.examined, read.expiringNext.next]).toEqual([4, null])
    expect(read.history).toEqual([])
    expect([read.found, read.probe]).toEqual([undefined, undefined])
  })

  it("pages a 5,000-row object so every open row is listed exactly once and the sum is held", async () => {
    const key = "customer:paged"
    const stub = stubFor(key)
    const t0 = midMonthAhead()
    let now = t0
    const pages = await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      const processor = await clockedProcessor(state, () => now)
      await processor.execute(upsert(key, roomy))
      // Closed charges sit in `due_at` between holds opened before and after them.
      for (let i = 0; i < 5_000; i++) {
        now = t0 + i * 1_000
        const reply =
          i % 5 === 0
            ? await processor.execute({
                type: "authorize",
                idempotencyKey: `hold_${i}`,
                amount: units(1),
                ttlMs: DAY,
              })
            : await processor.execute({
                type: "charge",
                idempotencyKey: `charge_${i}`,
                amount: units(0.01),
              })
        if (!reply.ok) throw new Error(reply.rejection.code)
      }
      now += 1_000
      const read = [inspection(await processor.inspect({}))]
      for (let after = read[0]?.expiringNext.next ?? null; after !== null; ) {
        const page = inspection(await processor.inspect({ after }))
        read.push(page)
        after = page.expiringNext.next
      }
      return read
    })

    const [first] = pages
    if (!first) throw new Error("no page")
    const held = first.budget.balance.held
    expect(held).toBe(units(1_000))
    expect(first.expiringNext.examined).toBe(INSPECT_SCAN_LIMIT)
    expect(first.expiringNext.next).not.toBeNull()
    expect(first.listed < held).toBe(true)
    const ids = pages.flatMap((page) => page.expiringNext.rows.map((row) => row.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(1_000)
    expect(pages.reduce((sum, page) => sum + page.listed, BigInt(0))).toBe(held)
    expect(pages.reduce((sum, page) => sum + page.expiringNext.examined, 0)).toBe(5_000)
  }, 120_000)

  it("finds a settled hold by its id and its idempotency key, and a lease by its key", async () => {
    const key = "customer:find"
    const stub = stubFor(key)
    await stub.execute(upsert(key, roomy))
    await stub.execute({ type: "authorize", idempotencyKey: "job-1", amount: units(5) })
    await stub.execute({ type: "settle", holdId: "h_1", amount: units(2) })
    await stub.execute({ type: "lease", leaseKey: "proc-1", amount: units(3), ttlMs: MINUTE })

    const byHold = inspection(await stub.inspect({ find: { by: "hold", holdId: "h_1" } })).found
    const byKey = inspection(
      await stub.inspect({ find: { by: "idempotencyKey", idempotencyKey: "job-1" } })
    ).found
    const lease = inspection(
      await stub.inspect({ find: { by: "lease", leaseKey: "proc-1" } })
    ).found
    const missing = inspection(await stub.inspect({ find: { by: "hold", holdId: "h_9" } }))

    expect(byHold).toMatchObject({
      kind: "hold",
      id: "h_1",
      idempotencyKey: "job-1",
      amount: units(5),
      state: { status: "settled", actual: units(2) },
    })
    expect(byKey).toEqual(byHold)
    expect(lease).toMatchObject({ kind: "lease", leaseKey: "proc-1", granted: units(3) })
    expect("found" in missing && missing.found).toBeNull()
  })

  it("probes an amount with the blocked a real authorize of it gets", async () => {
    const key = "customer:probe"
    const stub = stubFor(key)
    await stub.execute(
      upsert(key, {
        limits: [
          { id: "daily", amount: "20", window: "day" },
          { id: "monthly", amount: "50", window: "month" },
        ],
      })
    )
    await stub.execute({ type: "authorize", idempotencyKey: "a1", amount: units(15) })

    const query: BudgetInspectQuery = { probe: units(8) }
    const probed = inspection(await stub.inspect(query)).probe
    const real = await stub.execute({ type: "authorize", idempotencyKey: "a2", amount: units(8) })

    if (real.ok || real.rejection.code !== "LIMIT_EXCEEDED") throw new Error("expected a 402")
    expect(probed).toEqual({ amount: units(8), blocked: real.rejection.blocked })
    expect(probed?.blocked).toMatchObject({ limitId: "daily", remedy: "release_holds" })
    expect(inspection(await stub.inspect({ probe: units(5) })).probe).toEqual({
      amount: units(5),
      blocked: null,
    })
  })

  it("answers BUDGET_NOT_FOUND for a key never upserted and stores nothing for it", async () => {
    const stub = stubFor()

    expect(await stub.inspect({ probe: units(1) })).toEqual({
      ok: false,
      rejection: { code: "BUDGET_NOT_FOUND" },
    })

    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .filter(({ name }) => !name.startsWith("_cf_"))
      expect([tables, await state.storage.getAlarm()]).toEqual([[], null])
    })
  })

  it("lists rows closed in the last hour newest first, without open or older rows", async () => {
    const key = "customer:closed-recently"
    const stub = stubFor(key)
    const t0 = midMonthAhead()
    let now = t0
    const read = await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      const processor = await clockedProcessor(state, () => now)
      await processor.execute(upsert(key, roomy))
      await processor.execute({ type: "charge", idempotencyKey: "old", amount: units(1) })
      now = t0 + 2 * HOUR
      await processor.execute({ type: "authorize", idempotencyKey: "a1", amount: units(5) })
      await processor.execute({ type: "authorize", idempotencyKey: "a2", amount: units(5) })
      now += 1_000
      await processor.execute({ type: "settle", holdId: "h_1", amount: units(2) })
      now += 1_000
      await processor.execute({
        type: "record",
        idempotencyKey: "evt-1",
        amount: units(1),
        occurredAt: now,
      })
      now += 1_000
      return inspection(await processor.inspect({}))
    })

    expect(read.closedRecently.map((row) => [row.kind, row.id])).toEqual([
      ["record", "o:evt-1"],
      ["hold", "h_1"],
    ])
    expect(read.expiringNext.rows.map((row) => row.id)).toEqual(["h_2"])
  })
})
