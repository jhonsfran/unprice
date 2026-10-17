import { reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { upsertBudgetInputSchema } from "@unprice/db/validators"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { getBudgetStub } from "~/ingestion/do-placement"
import type { BudgetDO } from "./BudgetDO"
import { BudgetSqliteStore } from "./budget-store"
import * as schema from "./db/schema"
import { BudgetProcessor } from "./processor"

const UNIT = 100_000_000n
const DAY = 86_400_000

afterEach(reset)

function processor(
  state: DurableObjectState,
  now: number,
  setAlarm = (at: number) => state.storage.setAlarm(at)
) {
  return new BudgetProcessor({
    clock: { now: () => now },
    logger: { error: () => {} },
    scheduler: { getAlarm: () => state.storage.getAlarm(), setAlarm },
    store: new BudgetSqliteStore(drizzle(state.storage, { schema, logger: false })),
  })
}

async function created(key: string) {
  const stub = getBudgetStub(env, { projectId: "proj_1", key })
  const parsed = upsertBudgetInputSchema.parse({
    key,
    unit: "USD",
    limits: [{ id: "monthly", window: "month", anchor: "2020-01-15T00:00:00Z", amount: "100" }],
  })
  const reply = await stub.execute({ type: "upsert", projectId: "proj_1", ...parsed })
  expect(reply.ok).toBe(true)
  return stub
}

function ahead() {
  const date = new Date()
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 10, 12)
}

describe("alarm scheduling recovery", () => {
  it("keeps an earlier successful alarm when an older scheduling attempt fails", async () => {
    const stub = await created("alarm:concurrent-recovery")
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      const now = ahead()
      let rejectFirst: ((error: Error) => void) | undefined
      let calls = 0
      const current = processor(state, now, async (at) => {
        calls += 1
        if (calls === 1)
          return new Promise<void>((_resolve, reject) => {
            rejectFirst = reject
          })
        await state.storage.setAlarm(at)
      })
      await current.initialize()
      const command = {
        type: "record",
        idempotencyKey: "record",
        occurredAt: now,
        amount: UNIT,
      } as const
      const first = current.execute(command).catch((error: unknown) => error)
      expect(
        await current.execute({ type: "charge", idempotencyKey: "charge", amount: UNIT })
      ).toMatchObject({ ok: true })
      if (!rejectFirst) throw new Error("first scheduling call did not start")
      rejectFirst(new Error("older alarm failed"))
      expect(await first).toBeInstanceOf(Error)
      expect(await current.execute(command)).toMatchObject({
        ok: true,
        outcome: { replayed: true, balance: { remaining: 98n * UNIT } },
      })
      expect(await state.storage.getAlarm()).toBe(now + DAY)
      expect(calls).toBe(2)
    })
  })

  it("retries a failed alarm when an already committed charge replays", async () => {
    const stub = await created("alarm:replay-recovery")
    await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      const now = ahead()
      let calls = 0
      const current = processor(state, now, async (at) => {
        calls += 1
        if (calls === 1) throw new Error("schedule unavailable")
        await state.storage.setAlarm(at)
      })
      await current.initialize()
      const command = { type: "charge", idempotencyKey: "committed", amount: 10n * UNIT } as const
      await expect(current.execute(command)).rejects.toThrow("schedule unavailable")
      expect(await state.storage.getAlarm()).toBeNull()
      expect(await current.execute(command)).toMatchObject({
        ok: true,
        outcome: { replayed: true, balance: { remaining: 90n * UNIT } },
      })
      expect(await state.storage.getAlarm()).toBe(now + DAY)
      expect(calls).toBe(2)
      expect(
        state.storage.sql.exec("SELECT COUNT(*) AS count FROM budget_operations").one()
      ).toEqual({ count: 1 })
    })
  })
})
