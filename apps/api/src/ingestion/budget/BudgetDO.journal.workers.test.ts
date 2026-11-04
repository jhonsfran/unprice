import { reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { upsertBudgetInputSchema } from "@unprice/db/validators"
import { type BudgetJournalRow, budgetJournalRowSchema } from "@unprice/lakehouse"
import { amountUsage } from "@unprice/services/budgets"
import type { BudgetRequest } from "@unprice/services/use-cases"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { afterEach, describe, expect, it } from "vitest"
import { getBudgetStub } from "~/ingestion/do-placement"
import type { BudgetDO } from "./BudgetDO"
import { BudgetSqliteStore } from "./budget-store"
import * as schema from "./db/schema"
import migrations from "./drizzle/migrations"
import type { BudgetJournal } from "./journal"
import { ALARM_RETRY_MS, BudgetProcessor, JOURNAL_EXPORT_DELAY_MS } from "./processor"

const UNIT = BigInt(100_000_000)
const HOUR = 3_600_000

afterEach(reset)

/** A stream that records what it received, and fails while `failing` is set. */
function fakeJournal() {
  const sent: BudgetJournalRow[][] = []
  const journal = {
    failing: false,
    sent,
    async send(rows: readonly BudgetJournalRow[]) {
      if (journal.failing) throw new Error("stream unavailable")
      sent.push(rows.map((row) => budgetJournalRowSchema.parse(row)))
    },
  }
  return journal
}

function processor(
  state: DurableObjectState,
  now: () => number,
  journal: BudgetJournal | null,
  errors: string[] = []
) {
  return new BudgetProcessor({
    journal,
    runtime: { destroy: async () => {} },
    clock: { now },
    logger: { error: (message, fields) => errors.push(`${message}: ${fields.error}`) },
    scheduler: {
      getAlarm: () => state.storage.getAlarm(),
      setAlarm: (at) => state.storage.setAlarm(at),
    },
    store: new BudgetSqliteStore(drizzle(state.storage, { schema, logger: false })),
  })
}

function upsert(key: string): BudgetRequest {
  const parsed = upsertBudgetInputSchema.parse({
    key,
    unit: "USD",
    limits: [{ id: "month", amount: "50", window: "month" }],
  })
  return { type: "upsert", projectId: "proj_1", ...parsed, mayLoosen: true }
}

function midMonthAhead() {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 10, 12, 30)
}

const cursor = (state: DurableObjectState) =>
  state.storage.sql.exec("SELECT journal_seq, exported_seq FROM budget_ledger").one() as {
    journal_seq: number
    exported_seq: number
  }

const rowCount = (state: DurableObjectState) =>
  (state.storage.sql.exec("SELECT count(*) AS n FROM budget_operations").one() as { n: number }).n

describe("BudgetDO journal", () => {
  it("exports each row's latest write after the batching delay, in seq order", async () => {
    const key = "customer:journal-export"
    const stub = getBudgetStub(env, { projectId: "proj_1", key })
    const t0 = midMonthAhead()
    let now = t0
    const journal = fakeJournal()
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const budget = processor(state, () => now, journal)
      await budget.execute(upsert(key))
      await budget.execute({ type: "charge", idempotencyKey: "c1", usage: amountUsage(UNIT) })
      await budget.execute({ type: "authorize", idempotencyKey: "a1", usage: amountUsage(UNIT) })
      await budget.execute({ type: "settle", holdId: "h_1", actual: amountUsage(UNIT / BigInt(2)) })
      await expect(state.storage.getAlarm()).resolves.toBe(t0 + JOURNAL_EXPORT_DELAY_MS)

      now = t0 + JOURNAL_EXPORT_DELAY_MS
      await budget.alarm()
      const rows = journal.sent.flat()
      expect(
        rows.map(({ budget_key, project_id, kind, status, operation_id }) => ({
          budget_key,
          project_id,
          kind,
          status,
          operation_id,
        }))
      ).toEqual([
        {
          budget_key: key,
          project_id: "proj_1",
          kind: "charge",
          status: "done",
          operation_id: expect.stringMatching(/^o:/),
        },
        {
          budget_key: key,
          project_id: "proj_1",
          kind: "hold",
          status: "settled",
          operation_id: "h_1",
        },
      ])
      // The settle rewrote the hold, so its authorize version never left: seqs skip it.
      const seqs = rows.map((row) => row.seq)
      expect(seqs[0]).toBeGreaterThanOrEqual(t0 * 1_000)
      expect(seqs[1]).toBe((seqs[0] ?? 0) + 2)
      expect(rows[1]?.data).toMatchObject({
        reserved: { amount: "1" },
        state: { actual: { amount: "0.5" } },
      })
      expect(rows[0]?.timestamp).toBe(new Date(t0).toISOString())
      expect(cursor(state)).toEqual({ journal_seq: seqs[1], exported_seq: seqs[1] })

      await budget.alarm()
      expect(journal.sent).toHaveLength(1)
    })
  })

  it("keeps rows and the cursor when a send fails, and sends them on the retry", async () => {
    const key = "customer:journal-retry"
    const stub = getBudgetStub(env, { projectId: "proj_1", key })
    const t0 = midMonthAhead()
    let now = t0
    const journal = fakeJournal()
    const errors: string[] = []
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const budget = processor(state, () => now, journal, errors)
      await budget.execute(upsert(key))
      await budget.execute({ type: "charge", idempotencyKey: "c1", usage: amountUsage(UNIT) })

      journal.failing = true
      now = t0 + JOURNAL_EXPORT_DELAY_MS
      await budget.alarm()
      expect(errors).toEqual(["budget journal export failed: stream unavailable"])
      expect(cursor(state).exported_seq).toBe(0)
      await expect(state.storage.getAlarm()).resolves.toBe(now + ALARM_RETRY_MS)

      journal.failing = false
      now += ALARM_RETRY_MS
      await budget.alarm()
      expect(journal.sent.flat().map((row) => row.kind)).toEqual(["charge"])
      expect(cursor(state).exported_seq).toBe(cursor(state).journal_seq)
    })
  })

  it("purges a closed row only once the journal has it", async () => {
    const key = "customer:journal-purge"
    const stub = getBudgetStub(env, { projectId: "proj_1", key })
    const t0 = midMonthAhead()
    let now = t0
    const journal = fakeJournal()
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const budget = processor(state, () => now, journal)
      await budget.execute(upsert(key))
      await budget.execute({ type: "charge", idempotencyKey: "c1", usage: amountUsage(UNIT) })

      // Past the row's 24-hour retention, while the stream is down.
      journal.failing = true
      now = t0 + 25 * HOUR
      await budget.alarm()
      expect(rowCount(state)).toBe(1)

      journal.failing = false
      now += ALARM_RETRY_MS
      await budget.alarm()
      expect(rowCount(state)).toBe(0)
      expect(journal.sent.flat().map((row) => row.kind)).toEqual(["charge"])
    })
  })

  it("exports rows that sum to what the ledger consumed", async () => {
    const key = "customer:journal-rebuild"
    const stub = getBudgetStub(env, { projectId: "proj_1", key })
    const t0 = midMonthAhead()
    let now = t0
    const journal = fakeJournal()
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const budget = processor(state, () => now, journal)
      await budget.execute(upsert(key))
      for (let i = 0; i < 6; i++) {
        await budget.execute({
          type: "charge",
          idempotencyKey: `c${i}`,
          usage: amountUsage(BigInt(i + 1) * UNIT),
        })
        await budget.execute({
          type: "authorize",
          idempotencyKey: `a${i}`,
          usage: amountUsage(UNIT),
          ttlMs: 60_000,
        })
      }
      await budget.execute({ type: "settle", holdId: "h_1", actual: amountUsage(UNIT / BigInt(4)) })
      await budget.execute({ type: "release", holdId: "h_2" })
      // The other four holds expire and settle in full.
      now = t0 + HOUR
      await budget.alarm()

      // Readers keep each operation's highest seq, as at-least-once export requires.
      const latest = new Map<string, BudgetJournalRow>()
      for (const row of journal.sent.flat()) {
        const seen = latest.get(row.operation_id)
        if (!seen || seen.seq < row.seq) latest.set(row.operation_id, row)
      }
      const consumed = [...latest.values()].reduce((sum, row) => {
        const data = row.data as {
          usage?: { amount: string }
          state?: { status: string; actual?: { amount: string } }
        }
        if (row.kind === "charge") return sum + Number(data.usage?.amount)
        return sum + Number(data.state?.actual?.amount ?? 0)
      }, 0)
      const read = await budget.execute({ type: "get" })
      if (!read.ok || read.outcome.type !== "get") throw new Error("get failed")
      const month = read.outcome.budget.balance.limits.find((limit) => limit.id === "month")
      expect(consumed).toBe(21 + 0.25 + 4)
      expect(month?.consumed).toBe(BigInt(Math.round(consumed * 100)) * (UNIT / BigInt(100)))
    })
  })

  it("journals a row whose key a later command reused before the row was exported", async () => {
    const key = "customer:journal-reused-key"
    const stub = getBudgetStub(env, { projectId: "proj_1", key })
    const t0 = midMonthAhead()
    let now = t0
    const journal = fakeJournal()
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const budget = processor(state, () => now, journal)
      await budget.execute(upsert(key))
      journal.failing = true
      await budget.execute({ type: "charge", idempotencyKey: "k", usage: amountUsage(UNIT) })
      // Past the key's retention, the same key charges again while the stream is still down.
      now = t0 + 25 * HOUR
      await budget.execute({
        type: "charge",
        idempotencyKey: "k",
        usage: amountUsage(UNIT * BigInt(2)),
      })

      journal.failing = false
      now += ALARM_RETRY_MS
      await budget.alarm()
      const amounts = journal.sent
        .flat()
        .map((row) => (row.data as { usage: { amount: string } }).usage.amount)
      expect(amounts).toEqual(["1", "2"])
      expect(
        state.storage.sql.exec("SELECT count(*) AS n FROM budget_journal_backlog").one()
      ).toEqual({ n: 0 })
    })
  })

  it("without a stream keeps every row and never spins the alarm on them", async () => {
    const key = "customer:journal-unbound"
    const stub = getBudgetStub(env, { projectId: "proj_1", key })
    const t0 = midMonthAhead()
    let now = t0
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const budget = processor(state, () => now, null)
      await budget.execute(upsert(key))
      await budget.execute({ type: "charge", idempotencyKey: "c1", usage: amountUsage(UNIT) })
      await expect(state.storage.getAlarm()).resolves.toBe(t0 + 24 * HOUR)

      now = t0 + 25 * HOUR
      await budget.alarm()
      expect(rowCount(state)).toBe(1)
      await state.storage.deleteAlarm()
      await budget.alarm()
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })
  })
})
