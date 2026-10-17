import { reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { upsertBudgetInputSchema } from "@unprice/db/validators"
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
const DAY = 86_400_000
const HISTORY = 5_000
const SAMPLES = 21
type Sample = { statements: number; rowsRead: number; rowsWritten: number }
const cursors = new WeakMap<SqlStorage, SqlStorageCursor<Record<string, SqlStorageValue>>[]>()
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

function measure(sql: SqlStorage): Sample {
  const sample = (cursors.get(sql) ?? []).reduce(
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

function report(name: string, samples: Sample[], rpcMs: number[], details: object = {}) {
  console.info(
    `BUDGET_STORAGE_BENCHMARK ${JSON.stringify({
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

function requestKey(i: number, length: 36 | 256) {
  return `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`.padEnd(length, "x")
}

function upsert(key: string) {
  return {
    type: "upsert" as const,
    projectId: "proj_1",
    ...upsertBudgetInputSchema.parse({
      key,
      unit: "USD",
      limits: [{ id: "life", window: "never", amount: "1000000" }],
    }),
  }
}

function accepted(reply: BudgetReply) {
  if (!reply.ok) throw new Error(`expected success, got ${reply.rejection.code}`)
  return reply.outcome
}

function stubFor(key: string) {
  return getBudgetStub(env, { projectId: "proj_1", key })
}

function inspect(sql: SqlStorage) {
  const row = sql
    .exec(
      "SELECT count(*) AS n, coalesce(sum(length(data_json)), 0) AS payload FROM budget_operations"
    )
    .one()
  const result = {
    receipts: Number(row.n),
    payloadBytes: Number(row.payload),
    databaseBytes: sql.databaseSize,
  }
  measure(sql)
  return result
}

function processor(state: DurableObjectState, now: number) {
  const clock = {
    now,
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
  return clock
}

afterEach(async () => reset())

describe("BudgetDO storage work", () => {
  for (const keyLength of [36, 256] as const) {
    it(`measures accepted writes and exact replay with ${keyLength}-character keys`, async () => {
      const key = `storage:key:${keyLength}`
      const stub = stubFor(key)
      accepted(await stub.execute(upsert(key)))
      const empty = await runInDurableObject(stub, (_instance: BudgetDO, state) => {
        observe(state.storage.sql)
        return inspect(state.storage.sql)
      })
      const seedStart = performance.now()
      const seeded = await runInDurableObject(stub, async (instance: BudgetDO, state) => {
        for (let i = 0; i < HISTORY; i++) {
          accepted(
            await instance.execute({
              type: "record",
              idempotencyKey: requestKey(i, keyLength),
              amount: UNIT,
              occurredAt: Date.now(),
            })
          )
        }
        return { sql: measure(state.storage.sql), storage: inspect(state.storage.sql) }
      })
      report(`seed:key-length=${keyLength}`, [seeded.sql], [performance.now() - seedStart], {
        operations: HISTORY,
        before: empty,
        after: seeded.storage,
        bytesPerReceipt: (seeded.storage.databaseBytes - empty.databaseBytes) / HISTORY,
      })

      for (const replay of [false, true]) {
        const samples: Sample[] = []
        const rpcMs: number[] = []
        for (let i = 0; i < SAMPLES; i++) {
          const request: BudgetRequest = {
            type: "record",
            idempotencyKey: requestKey(replay ? i : HISTORY + i, keyLength),
            amount: UNIT,
            occurredAt: Date.now(),
          }
          const started = performance.now()
          const result = accepted(await stub.execute(request))
          rpcMs.push(performance.now() - started)
          expect(isOutcomeOf(result, "record") && result.replayed).toBe(replay)
          expect(isOutcomeOf(result, "record") && result.amount).toBe(UNIT)
          samples.push(
            await runInDurableObject(stub, (_instance: BudgetDO, state) =>
              measure(state.storage.sql)
            )
          )
        }
        report(`${replay ? "replay" : "record"}:key-length=${keyLength}`, samples, rpcMs)
      }
      expect(
        await stub.execute({
          type: "charge",
          idempotencyKey: requestKey(0, keyLength),
          amount: UNIT,
        })
      ).toEqual({
        ok: false,
        rejection: { code: "IDEMPOTENCY_CONFLICT", idempotencyKey: requestKey(0, keyLength) },
      })
      const current = accepted(await stub.execute({ type: "get" }))
      expect(isOutcomeOf(current, "get") && current.budget.balance.remaining).toBe(
        BigInt(1_000_000 - HISTORY - SAMPLES) * UNIT
      )
    }, 120_000)
  }

  for (const { perSecond, initialBacklog } of [
    { perSecond: 256, initialBacklog: 0 },
    { perSecond: 1024, initialBacklog: 0 },
    { perSecond: 1024, initialBacklog: 2048 },
  ]) {
    it(`measures cleanup with ${perSecond} receipts becoming due per second and ${initialBacklog} already due`, async () => {
      const key = `storage:cleanup:${perSecond}`
      const stub = stubFor(key)
      accepted(await stub.execute(upsert(key)))
      const start = Date.now() + DAY
      const seconds = 4
      await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
        const clock = processor(state, start)
        for (let i = 0; i < 512; i++)
          accepted(
            await clock.processor.execute({
              type: "authorize",
              idempotencyKey: `open_${i}`,
              amount: UNIT,
            })
          )
        for (let i = 0; i < initialBacklog; i++)
          accepted(
            await clock.processor.execute({
              type: "record",
              idempotencyKey: `backlog_${i}`,
              amount: BigInt(0),
              occurredAt: start,
            })
          )
        for (let second = 0; second < seconds; second++) {
          clock.now = start + second * 1000
          for (let i = 0; i < perSecond; i++)
            accepted(
              await clock.processor.execute({
                type: "record",
                idempotencyKey: requestKey(second * perSecond + i, 36),
                amount: BigInt(0),
                occurredAt: clock.now,
              })
            )
        }
        observe(state.storage.sql)
        measure(state.storage.sql)
      })
      const samples: Sample[] = []
      const rpcMs: number[] = []
      const backlog: number[] = []
      const removed: number[] = []
      for (let second = 0; second < seconds; second++) {
        const begun = performance.now()
        const result = await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
          const clock = clocks.get(state.storage.sql)
          if (!clock) throw new Error("missing clock")
          clock.now = start + 8 * DAY + second * 1000
          const countBefore = inspect(state.storage.sql).receipts
          await clock.processor.alarm()
          const sql = measure(state.storage.sql)
          const countAfter = inspect(state.storage.sql).receipts
          const due = state.storage.sql
            .exec(
              "SELECT count(*) AS n FROM budget_operations WHERE status = 'done' AND due_at <= ?",
              clock.now
            )
            .one()
          measure(state.storage.sql)
          return { sql, removed: countBefore - countAfter, backlog: Number(due.n) }
        })
        rpcMs.push(performance.now() - begun)
        samples.push(result.sql)
        removed.push(result.removed)
        backlog.push(result.backlog)
      }
      await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
        const clock = clocks.get(state.storage.sql)
        if (!clock) throw new Error("missing clock")
        const current = accepted(await clock.processor.execute({ type: "get" }))
        expect(isOutcomeOf(current, "get") && current.budget.balance.held).toBe(BigInt(512) * UNIT)
        expect(
          state.storage.sql
            .exec("SELECT count(*) AS n FROM budget_operations WHERE status = 'open'")
            .one()
        ).toEqual({ n: 512 })
      })
      expect(removed.reduce((sum, value) => sum + value, 0) + (backlog.at(-1) ?? 0)).toBe(
        perSecond * seconds + initialBacklog
      )
      report(
        `cleanup:due-per-second=${perSecond}:open-holds=512${initialBacklog ? `:initial-backlog=${initialBacklog}` : ""}`,
        samples,
        rpcMs,
        {
          removed,
          backlog,
          simulatedSeconds: seconds,
          initialBacklog,
          rowsReadPerRemoved:
            samples.reduce((sum, sample) => sum + sample.rowsRead, 0) /
            removed.reduce((sum, count) => sum + count, 0),
          rowsWrittenPerRemoved:
            samples.reduce((sum, sample) => sum + sample.rowsWritten, 0) /
            removed.reduce((sum, count) => sum + count, 0),
        }
      )
      if (initialBacklog > 0) expect(backlog.at(-1)).toBe(0)
    }, 120_000)
  }
})
