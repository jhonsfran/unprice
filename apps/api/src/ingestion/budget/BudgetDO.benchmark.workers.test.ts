import { reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { type BudgetConfigInput, upsertBudgetInputSchema } from "@unprice/db/validators"
import { isOutcomeOf } from "@unprice/services/budgets"
import type { BudgetReply, BudgetRequest } from "@unprice/services/use-cases"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { getBudgetStub } from "~/ingestion/do-placement"
import type { BudgetDO } from "./BudgetDO"
import { BudgetSqliteStore } from "./budget-store"
import * as schema from "./db/schema"
import { BudgetProcessor } from "./processor"

const UNIT = BigInt(100_000_000)
const DAY = 24 * 60 * 60 * 1000
const SAMPLES = 21
type NativeCursor = SqlStorageCursor<Record<string, SqlStorageValue>>
type SqlSample = { statements: number; rowsRead: number; rowsWritten: number }
const cursors = new WeakMap<SqlStorage, NativeCursor[]>()
const clocks = new WeakMap<SqlStorage, { now: number; processor: BudgetProcessor }>()

function observe(sql: SqlStorage) {
  if (cursors.has(sql)) return
  cursors.set(sql, [])
  const exec = sql.exec.bind(sql)
  Object.defineProperty(sql, "exec", {
    configurable: true,
    value: <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) => {
      const cursor = exec<T>(query, ...bindings)
      cursors.get(sql)?.push(cursor)
      return cursor
    },
  })
}

function sqlSample(sql: SqlStorage): SqlSample {
  const current = cursors.get(sql) ?? []
  const sample = current.reduce(
    (sum, cursor) => ({
      statements: sum.statements + 1,
      rowsRead: sum.rowsRead + cursor.rowsRead,
      rowsWritten: sum.rowsWritten + cursor.rowsWritten,
    }),
    { statements: 0, rowsRead: 0, rowsWritten: 0 }
  )
  cursors.set(sql, [])
  return sample
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0
  return { min: sorted[0], median: at(0.5), p95: at(0.95), max: sorted.at(-1) }
}

function report(name: string, samples: SqlSample[], rpcMs: number[], details: object = {}) {
  console.info(
    `BUDGET_BENCHMARK ${JSON.stringify({
      name,
      samples: samples.length,
      statements: distribution(samples.map((sample) => sample.statements)),
      rowsRead: distribution(samples.map((sample) => sample.rowsRead)),
      rowsWritten: distribution(samples.map((sample) => sample.rowsWritten)),
      rpcMs: distribution(rpcMs),
      ...details,
    })}`
  )
}

function upsert(key: string, limits = 1, amount = "1000000"): BudgetRequest {
  const config: BudgetConfigInput = {
    limits: Array.from({ length: limits }, (_, i) => ({
      id: `limit_${i}`,
      amount,
      window: "month",
      anchor: Date.UTC(2020, 0, i + 1, 3),
    })),
  }
  return {
    type: "upsert",
    projectId: "proj_1",
    ...upsertBudgetInputSchema.parse({ key, unit: "USD", ...config }),
    mayLoosen: true,
  }
}

function accepted(reply: BudgetReply) {
  if (!reply.ok) throw new Error(`expected success, got ${reply.rejection.code}`)
  return reply.outcome
}

function stubFor(key: string) {
  return getBudgetStub(env, { projectId: "proj_1", key })
}

async function inspect(stub: ReturnType<typeof stubFor>) {
  return runInDurableObject(stub, (_instance: BudgetDO, state) => {
    const sql = state.storage.sql
    const count = sql
      .exec(
        "SELECT count(*) AS n, coalesce(sum(length(data_json)), 0) AS payload FROM budget_operations"
      )
      .one()
    const ledger = sql
      .exec("SELECT usage_json AS usage, length(usage_json) AS bytes FROM budget_ledger")
      .one()
    const size = sql.databaseSize
    sqlSample(sql)
    return {
      receipts: count.n,
      receiptPayloadBytes: count.payload,
      ledgerBytes: ledger.bytes,
      counters: Object.keys(JSON.parse(String(ledger.usage))).length,
      databaseBytes: size,
    }
  })
}

async function prepare(key: string, limits: number, history: number, amount = "1000000") {
  const stub = stubFor(key)
  accepted(await stub.execute(upsert(key, limits, amount)))
  await runInDurableObject(stub, async (instance: BudgetDO, state) => {
    for (let i = 0; i < history; i++) {
      accepted(
        await instance.execute({
          type: "record",
          idempotencyKey: `seed_${i}`,
          amount: UNIT,
          occurredAt: Date.now(),
        })
      )
    }
    observe(state.storage.sql)
    sqlSample(state.storage.sql)
  })
  return stub
}

async function sample(stub: ReturnType<typeof stubFor>, request: BudgetRequest) {
  const start = performance.now()
  const reply = await stub.execute(request)
  const rpcMs = performance.now() - start
  const sql = await runInDurableObject(stub, (_instance: BudgetDO, state) =>
    sqlSample(state.storage.sql)
  )
  return { reply, rpcMs, sql }
}

afterEach(async () => reset())

describe("BudgetDO measured work", () => {
  it("observes native cursors after iteration without counting inspection queries", async () => {
    const stub = await prepare("bench:instrumentation", 1, 0)
    const measured = await sample(stub, {
      type: "record",
      idempotencyKey: "first",
      amount: UNIT,
      occurredAt: Date.now(),
    })
    const outcome = accepted(measured.reply)
    expect(isOutcomeOf(outcome, "record") && outcome.balance.remaining).toBe(BigInt(999999) * UNIT)
    expect(measured.sql.statements).toBeGreaterThanOrEqual(2)
    expect(measured.sql.rowsWritten).toBeGreaterThanOrEqual(2)
    expect(
      await runInDurableObject(stub, (_instance: BudgetDO, state) => sqlSample(state.storage.sql))
    ).toEqual({ statements: 0, rowsRead: 0, rowsWritten: 0 })
    report("instrumentation", [measured.sql], [measured.rpcMs], await inspect(stub))
  })

  for (const verb of ["record", "charge"] as const) {
    for (const limits of [1, 16]) {
      for (const history of [0, 1000, 5000]) {
        it(`${verb}, ${limits} limits, ${history} retained receipts`, async () => {
          const name = `${verb}:limits=${limits}:history=${history}`
          const stub = await prepare(`bench:${verb}:${limits}:${history}`, limits, history)
          const before = await inspect(stub)
          const samples: SqlSample[] = []
          const rpcMs: number[] = []
          for (let i = 0; i < SAMPLES; i++) {
            const measured = await sample(stub, {
              type: verb,
              idempotencyKey: `sample_${i}`,
              amount: UNIT,
              ...(verb === "record" ? { occurredAt: Date.now() } : {}),
            } as BudgetRequest)
            const outcome = accepted(measured.reply)
            expect(isOutcomeOf(outcome, verb) && outcome.replayed).toBe(false)
            expect(isOutcomeOf(outcome, verb) && outcome.balance.remaining).toBe(
              BigInt(1_000_000 - history - i - 1) * UNIT
            )
            samples.push(measured.sql)
            rpcMs.push(measured.rpcMs)
          }
          const after = await inspect(stub)
          expect(after.receipts).toBe(history + SAMPLES)
          report(name, samples, rpcMs, { before, after })
        }, 120_000)
      }
    }
  }

  for (const limits of [1, 16]) {
    it(`authorizes and settles against ${limits} limits with 1000 receipts`, async () => {
      const stub = await prepare(`bench:holds:${limits}`, limits, 1000)
      const before = await inspect(stub)
      const authorization: SqlSample[] = []
      const settlement: SqlSample[] = []
      const authorizeMs: number[] = []
      const settleMs: number[] = []
      for (let i = 0; i < SAMPLES; i++) {
        const held = await sample(stub, {
          type: "authorize",
          idempotencyKey: `hold_${i}`,
          amount: UNIT * BigInt(2),
        })
        const hold = accepted(held.reply)
        if (!isOutcomeOf(hold, "authorize")) throw new Error("expected authorize")
        expect(hold.balance.held).toBe(UNIT * BigInt(2))
        const closed = await sample(stub, { type: "settle", holdId: hold.holdId, amount: UNIT })
        const settle = accepted(closed.reply)
        if (!isOutcomeOf(settle, "settle")) throw new Error("expected settle")
        expect([
          settle.actual,
          settle.released,
          settle.balance.held,
          settle.balance.remaining,
        ]).toEqual([UNIT, UNIT, BigInt(0), BigInt(998999 - i) * UNIT])
        authorization.push(held.sql)
        settlement.push(closed.sql)
        authorizeMs.push(held.rpcMs)
        settleMs.push(closed.rpcMs)
      }
      const after = await inspect(stub)
      expect(after.receipts).toBe(1021)
      report(`authorize:limits=${limits}:history=1000`, authorization, authorizeMs, {
        before,
        after,
      })
      report(`settle:limits=${limits}:history=1000`, settlement, settleMs, { before, after })
    }, 120_000)
  }

  it("measures replay and denied admission with 1000 receipts", async () => {
    const stub = await prepare("bench:replay-denial", 1, 1000, "1000")
    const before = await inspect(stub)
    for (const type of ["replay", "denial"] as const) {
      const samples: SqlSample[] = []
      const rpcMs: number[] = []
      for (let i = 0; i < SAMPLES; i++) {
        const measured = await sample(
          stub,
          type === "replay"
            ? { type: "record", idempotencyKey: "seed_0", amount: UNIT, occurredAt: Date.now() }
            : { type: "charge", idempotencyKey: `deny_${i}`, amount: UNIT }
        )
        if (type === "replay") {
          const outcome = accepted(measured.reply)
          expect(isOutcomeOf(outcome, "record") && outcome.replayed).toBe(true)
          expect(isOutcomeOf(outcome, "record") && outcome.balance.remaining).toBe(BigInt(0))
        } else {
          expect(measured.reply).toMatchObject({
            ok: false,
            rejection: { code: "LIMIT_EXCEEDED", blocked: { remaining: BigInt(0) } },
          })
        }
        samples.push(measured.sql)
        rpcMs.push(measured.rpcMs)
      }
      expect((await inspect(stub)).receipts).toBe(1000)
      report(`${type}:history=1000`, samples, rpcMs, { before })
    }
  })

  for (const objects of [1, 16]) {
    it(`measures concurrent admitted writes across ${objects} objects`, async () => {
      const stubs = await Promise.all(
        Array.from({ length: objects }, (_, i) =>
          prepare(`bench:concurrent:${objects}:${i}`, 1, 1000)
        )
      )
      const samples: SqlSample[] = []
      const batchMs: number[] = []
      const rpcMs: number[] = []
      const width = 32
      const batches = 7
      for (let batch = 0; batch < batches; batch++) {
        const started = performance.now()
        const replies = await Promise.all(
          Array.from({ length: width }, async (_, i) => {
            const stub = stubs[i % objects]
            if (!stub) throw new Error("missing object")
            const start = performance.now()
            const reply = await stub.execute({
              type: "charge",
              idempotencyKey: `batch_${batch}_${i}`,
              amount: UNIT,
            })
            rpcMs.push(performance.now() - start)
            return reply
          })
        )
        batchMs.push(performance.now() - started)
        for (const reply of replies) {
          const outcome = accepted(reply)
          expect(isOutcomeOf(outcome, "charge") && outcome.replayed).toBe(false)
        }
        const measured = await Promise.all(
          stubs.map((stub) =>
            runInDurableObject(stub, (_instance: BudgetDO, state) => sqlSample(state.storage.sql))
          )
        )
        samples.push(
          measured.reduce(
            (sum, item) => ({
              statements: sum.statements + item.statements,
              rowsRead: sum.rowsRead + item.rowsRead,
              rowsWritten: sum.rowsWritten + item.rowsWritten,
            }),
            { statements: 0, rowsRead: 0, rowsWritten: 0 }
          )
        )
      }
      for (const stub of stubs) {
        const current = accepted(await stub.execute({ type: "get" }))
        expect(isOutcomeOf(current, "get") && current.budget.balance.remaining).toBe(
          BigInt(999000 - (width * batches) / objects) * UNIT
        )
      }
      report(`concurrent:objects=${objects}:history=1000`, samples, rpcMs, {
        operationsPerSample: width,
        batchMs: distribution(batchMs),
        objectCount: objects,
      })
    }, 120_000)
  }

  for (const changes of [0, 100, 1000]) {
    it(`measures a charge after ${changes} equivalent monthly schedule changes`, async () => {
      const key = `bench:churn:${changes}`
      const stub = await prepare(key, 1, 0)
      await runInDurableObject(stub, async (instance: BudgetDO, state) => {
        for (let i = 0; i < changes; i++) {
          accepted(
            await instance.execute({
              type: "upsert",
              projectId: "proj_1",
              ...upsertBudgetInputSchema.parse({
                key,
                unit: "USD",
                limits: [
                  {
                    id: `schedule_${i}`,
                    amount: "1000000",
                    window: "month",
                    anchor: Date.UTC(2020 + i, 0, 10, 3),
                  },
                ],
              }),
              mayLoosen: true,
            })
          )
        }
        sqlSample(state.storage.sql)
      })
      const before = await inspect(stub)
      const samples: SqlSample[] = []
      const rpcMs: number[] = []
      for (let i = 0; i < SAMPLES; i++) {
        const measured = await sample(stub, {
          type: "charge",
          idempotencyKey: `churn_charge_${i}`,
          amount: UNIT,
        })
        const outcome = accepted(measured.reply)
        expect(isOutcomeOf(outcome, "charge") && outcome.balance.remaining).toBe(
          BigInt(999999 - i) * UNIT
        )
        samples.push(measured.sql)
        rpcMs.push(measured.rpcMs)
      }
      report(`charge:equivalent-schedule-changes=${changes}`, samples, rpcMs, {
        before,
        after: await inspect(stub),
      })
    }, 120_000)
  }

  for (const history of [0, 1000, 5000]) {
    it(`measures expiry of 64 holds behind ${history} due receipts`, async () => {
      const admission: SqlSample[] = []
      const alarm: SqlSample[] = []
      const admissionMs: number[] = []
      const alarmMs: number[] = []
      const admitted: boolean[] = []
      const receiptCounts: Array<{ before: unknown; after: unknown }> = []
      for (let repetition = 0; repetition < 3; repetition++) {
        const key = `bench:expiry:${history}:${repetition}`
        const stub = await prepare(key, 1, 0, "64")
        await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
          const date = new Date()
          const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 10, 12, 30)
          const clock = {
            now: start,
            processor: new BudgetProcessor({
              clock: { now: () => clock.now },
              logger: {
                error: (message) => {
                  throw new Error(message)
                },
              },
              scheduler: {
                getAlarm: () => state.storage.getAlarm(),
                setAlarm: (at) => state.storage.setAlarm(at),
              },
              store: new BudgetSqliteStore(drizzle(state.storage, { schema, logger: false })),
            }),
          }
          clocks.set(state.storage.sql, clock)
          for (let i = 0; i < history; i++) {
            accepted(
              await clock.processor.execute({
                type: "record",
                idempotencyKey: `receipt_${i}`,
                amount: BigInt(0),
                occurredAt: clock.now,
              })
            )
          }
          clock.now = start + 8 * DAY - 2999
          for (let i = 0; i < 64; i++) {
            accepted(
              await clock.processor.execute({
                type: "authorize",
                idempotencyKey: `expired_${i}`,
                amount: UNIT,
                ttlMs: 1000,
              })
            )
          }
          clock.now = start + 8 * DAY + 2
          sqlSample(state.storage.sql)
        })
        const before = await inspect(stub)
        const requestStart = performance.now()
        const request = await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
          const clock = clocks.get(state.storage.sql)
          if (!clock) throw new Error("missing clock")
          return clock.processor.execute({
            type: "authorize",
            idempotencyKey: "after_expiry",
            amount: UNIT * BigInt(40),
          })
        })
        admissionMs.push(performance.now() - requestStart)
        admission.push(
          await runInDurableObject(stub, (_instance: BudgetDO, state) =>
            sqlSample(state.storage.sql)
          )
        )
        admitted.push(request.ok)
        if (request.ok) {
          if (!isOutcomeOf(request.outcome, "authorize")) throw new Error("expected authorize")
          expect(request.outcome.amount).toBe(UNIT * BigInt(40))
          const holdId = request.outcome.holdId
          await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
            const clock = clocks.get(state.storage.sql)
            if (!clock) throw new Error("missing clock")
            accepted(await clock.processor.execute({ type: "release", holdId }))
            sqlSample(state.storage.sql)
          })
        } else {
          expect(request.rejection.code).toBe("LIMIT_EXCEEDED")
        }
        const alarmStart = performance.now()
        await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
          const clock = clocks.get(state.storage.sql)
          if (!clock) throw new Error("missing clock")
          await clock.processor.alarm()
        })
        alarmMs.push(performance.now() - alarmStart)
        alarm.push(
          await runInDurableObject(stub, (_instance: BudgetDO, state) =>
            sqlSample(state.storage.sql)
          )
        )
        const after = await inspect(stub)
        receiptCounts.push({ before, after })
        // The alarm settled every expired hold at its full amount.
        const settled = await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
          const clock = clocks.get(state.storage.sql)
          if (!clock) throw new Error("missing clock")
          return clock.processor.execute({ type: "get" })
        })
        const outcome = accepted(settled)
        const balance = isOutcomeOf(outcome, "get") ? outcome.budget.balance : null
        expect([balance?.held, balance?.limits[0]?.consumed]).toEqual([
          BigInt(0),
          UNIT * BigInt(64),
        ])
      }
      report(`expiry64:due-receipts=${history}`, admission, admissionMs, {
        admitted,
        transport: "runInDurableObject with real SQLite and injected clock",
      })
      report(`alarm64:due-receipts=${history}`, alarm, alarmMs, {
        receiptCounts,
        transport: "runInDurableObject with real SQLite and injected clock",
      })
    }, 120_000)
  }
})
