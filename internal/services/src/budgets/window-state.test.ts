import { upsertBudgetInputSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import type { BudgetCommand, BudgetConfigInput, BudgetTransition } from "./index"
import { MemoryBudgetStore } from "./memory-store.fixture"
import { windowIdOf } from "./windows"

const now = Date.parse("2026-10-16T12:00:00.000Z")
const day = 86_400_000
const $ = (amount: number) => BigInt(amount) * BigInt("100000000")

function upsert(input: BudgetConfigInput): BudgetCommand {
  const parsed = upsertBudgetInputSchema.parse({ key: "windows", unit: "USD", ...input })
  return {
    type: "upsert",
    key: "windows",
    projectId: "proj_1",
    unit: "money:USD",
    config: parsed.config,
  }
}

function ok(result: ReturnType<MemoryBudgetStore["run"]>): BudgetTransition {
  if (result.err) throw result.err
  return result.val
}

function rejection(result: ReturnType<MemoryBudgetStore["run"]>) {
  if (!result.err) throw new Error(`expected rejection, received ${result.val.outcome.type}`)
  return result.err.rejection
}

function create(input: BudgetConfigInput) {
  const store = new MemoryBudgetStore()
  ok(store.run(upsert(input), now))
  return store
}

function snapshot(store: MemoryBudgetStore, at = now) {
  const result = ok(store.run({ type: "get" }, at)).outcome
  if (result.type !== "get") throw new Error("get returned another outcome")
  return result
}

const charge = (key: string, amount: number): BudgetCommand => ({
  type: "charge",
  idempotencyKey: key,
  amount: $(amount),
})

describe("canonical budget schedules", () => {
  it("drops retired history when the same update starts tracking the schedule again", () => {
    const config: BudgetConfigInput = {
      limits: [{ id: "billing", window: "month", anchor: "2020-01-01T00:00:00Z", amount: "100" }],
    }
    const store = create(config)
    ok(store.run(charge("old", 10), now))
    ok(store.run(upsert({ limits: [] }), Date.parse("2026-11-01T00:00:00Z")))
    expect([...store.history.values()].flat()).toHaveLength(1)
    const restarted = Date.parse("2026-12-02T00:00:00Z")
    ok(store.run(upsert(config), restarted))
    const read = snapshot(store, restarted)
    expect(read.budget.balance.remaining).toBe($(100))
    expect(read.history).toEqual([])
  })

  it("keeps capacity through 1,000 equivalent monthly anchors", () => {
    const store = create({
      limits: [{ id: "billing", window: "month", anchor: "2020-01-15T09:30:00Z", amount: "100" }],
    })
    ok(store.run(charge("before", 80), now))
    for (let index = 0; index < 1_000; index += 1) {
      const anchor = new Date(
        Date.UTC(2000 + Math.floor(index / 12), index % 12, 15, 9, 30)
      ).toISOString()
      ok(
        store.run(
          upsert({ limits: [{ id: "billing", window: "month", anchor, amount: "100" }] }),
          now
        )
      )
    }
    expect(Object.keys(store.ledger.usage)).toHaveLength(6)
    expect(snapshot(store).budget.balance.remaining).toBe($(20))
    expect(rejection(store.run(charge("denied", 21), now)).code).toBe("LIMIT_EXCEEDED")
    expect(ok(store.run(charge("accepted", 20), now)).outcome).toMatchObject({
      balance: { remaining: BigInt("0") },
    })
  })

  it("rejects a new schedule at capacity and preserves removed schedules until their period ends", () => {
    const store = create({ limits: [] })
    for (let index = 0; index < 32; index += 1) {
      const anchor = new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString()
      ok(
        store.run(
          upsert({ limits: [{ id: `schedule_${index}`, window: "month", anchor, amount: "100" }] }),
          now
        )
      )
    }
    ok(store.run(charge("before", 70), now))
    const before = store.ledger
    expect(
      rejection(
        store.run(
          upsert({
            limits: [
              { id: "extra", window: "month", anchor: "2026-10-02T00:00:00Z", amount: "100" },
            ],
          }),
          now
        )
      )
    ).toMatchObject({ code: "WINDOW_CAPACITY_EXCEEDED", maximum: 32, retained: 32 })
    expect(store.ledger).toBe(before)
    ok(
      store.run(
        upsert({
          limits: [
            { id: "first_again", window: "month", anchor: "2020-01-01T00:00:00Z", amount: "100" },
          ],
        }),
        now
      )
    )
    expect(snapshot(store).budget.balance.remaining).toBe($(30))
    const nextMonth = Date.parse("2026-11-02T00:00:00Z")
    ok(
      store.run(
        upsert({
          limits: [{ id: "extra", window: "month", anchor: "2026-10-02T00:00:00Z", amount: "100" }],
        }),
        nextMonth
      )
    )
    expect(snapshot(store, nextMonth).budget.balance.remaining).toBe($(100))
    expect(Object.keys(store.ledger.usage)).toHaveLength(7)
  })

  it("keeps monthly day 30 and day 31 distinct and anchored midnight separate from calendar", () => {
    expect(windowIdOf({ window: "month", anchor: Date.parse("2026-01-30T00:00:00Z") })).toBe(
      "month@1970-01-30T00:00:00.000Z"
    )
    expect(windowIdOf({ window: "month", anchor: Date.parse("2026-01-31T00:00:00Z") })).toBe(
      "month@1970-01-31T00:00:00.000Z"
    )
    const store = create({ limits: [{ id: "calendar", window: "day", amount: "100" }] })
    ok(store.run(charge("before", 70), now))
    ok(
      store.run(
        upsert({
          limits: [
            { id: "anchored", window: "day", anchor: "2026-01-01T00:00:00Z", amount: "100" },
          ],
        }),
        now
      )
    )
    expect(snapshot(store).budget.balance.remaining).toBe($(100))
    expect(store.ledger.usage.day.consumed).toBe($(70))
  })
})

describe("consumed thresholds and actionable denials", () => {
  it("reports a soft crossing on actual consumption despite releasing spare capacity", () => {
    const store = create({
      limits: [{ id: "soft", window: "month", amount: "50", enforce: "soft" }],
    })
    ok(store.run({ type: "authorize", idempotencyKey: "work", amount: $(80) }, now))
    const command = { type: "settle", holdId: "h_1", amount: $(60) } as const
    expect(ok(store.run(command, now)).outcome).toMatchObject({
      actual: $(60),
      released: $(20),
      crossed: ["soft"],
      replayed: false,
    })
    expect(ok(store.run(command, now + day / 2)).outcome).toMatchObject({
      crossed: ["soft"],
      replayed: true,
    })
  })

  it("does not recommend a reset when retained holds alone block the request", () => {
    const store = create({ limits: [{ id: "daily", window: "day", amount: "100" }] })
    ok(store.run(charge("used", 10), now))
    ok(store.run({ type: "authorize", idempotencyKey: "open", amount: $(30) }, now))
    expect(rejection(store.run(charge("denied", 80), now))).toMatchObject({
      code: "LIMIT_EXCEEDED",
      blocked: { remedy: "release_holds" },
    })
  })

  it("does not promise one action when different limits need separate actions", () => {
    const store = create({ limits: [{ id: "monthly", window: "month", amount: "150" }] })
    ok(store.run(charge("old", 90), now - day))
    ok(store.run(charge("today", 10), now))
    ok(
      store.run(
        upsert({
          limits: [
            { id: "monthly", window: "month", amount: "150" },
            { id: "daily", window: "day", anchor: "2026-01-01T12:00:00Z", amount: "100" },
          ],
        }),
        now
      )
    )
    ok(store.run(charge("anchored", 10), now))
    ok(store.run({ type: "authorize", idempotencyKey: "open", amount: $(30) }, now))
    expect(rejection(store.run(charge("denied", 80), now))).toMatchObject({
      code: "LIMIT_EXCEEDED",
      blocked: { remedy: "raise_limit" },
    })
  })
})
