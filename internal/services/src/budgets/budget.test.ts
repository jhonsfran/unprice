import { upsertBudgetInputSchema } from "@unprice/db/validators"
import { formatAmount } from "@unprice/money"
import { describe, expect, it } from "vitest"
import {
  type BudgetCommand,
  type BudgetConfigInput,
  type BudgetTransition,
  type BudgetView,
  CLOSED_BUDGET_RETENTION_MS,
  type HoldOperation,
  checkTransition,
  consume,
  emptyLedger,
  formatBudgetConfig,
  transition,
} from "./index"
import { MemoryBudgetStore } from "./memory-store.fixture"

const t0 = Date.parse("2026-10-14T10:00:00.000Z")
const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const nov1 = Date.parse("2026-11-01T00:00:00.000Z")
const oct15 = Date.parse("2026-10-15T00:00:00.000Z")

/** Whole units to base units at scale 8. */
const $ = (units: number) => BigInt(units) * BigInt(100_000_000)

const month100: BudgetConfigInput = { limits: [{ id: "month", amount: "100", window: "month" }] }

const wire = (input: BudgetConfigInput) =>
  upsertBudgetInputSchema.safeParse({ key: "customer:acme", unit: "USD", ...input })

function config(input: BudgetConfigInput) {
  const parsed = wire(input)
  if (!parsed.success) throw parsed.error
  return parsed.data.config
}

function issues(input: BudgetConfigInput) {
  const parsed = wire(input)
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
}

function upsert(input: BudgetConfigInput, unit = "money:USD", mayLoosen = true): BudgetCommand {
  const parsed = config(input)
  return {
    type: "upsert",
    key: "customer:acme",
    projectId: "proj_1",
    unit,
    config: parsed,
    mayLoosen,
  }
}

function authorize(key: string, units: number, ttlMs?: number): BudgetCommand {
  return { type: "authorize", idempotencyKey: key, amount: $(units), ttlMs }
}

function oneShot(
  type: "charge" | "record",
  key: string,
  amount: bigint,
  occurredAt = t0
): BudgetCommand {
  if (type === "charge") return { type, idempotencyKey: key, amount }
  return { type, idempotencyKey: key, amount, occurredAt }
}

const charge = (key: string, units: number) => oneShot("charge", key, $(units))
const record = (key: string, units: number, occurredAt = t0) =>
  oneShot("record", key, $(units), occurredAt)
const settle = (holdId: string, units: number): BudgetCommand => ({
  type: "settle",
  holdId,
  amount: $(units),
})
const release = (holdId: string): BudgetCommand => ({ type: "release", holdId })

function budgetWith(input: BudgetConfigInput, at = t0) {
  const store = new MemoryBudgetStore()
  ok(store.run(upsert(input), at))
  return store
}

function ok(result: ReturnType<MemoryBudgetStore["run"]>): BudgetTransition {
  if (result.err) throw result.err
  return result.val
}

function rejection(result: ReturnType<MemoryBudgetStore["run"]>) {
  if (!result.err) throw new Error(`expected a rejection, got ${result.val.outcome.type}`)
  return result.err.rejection
}

function remaining(transition: BudgetTransition) {
  const { outcome } = transition
  const balance =
    "balance" in outcome ? outcome.balance : "budget" in outcome ? outcome.budget.balance : null
  if (!balance) throw new Error(`${outcome.type} has no balance`)
  return balance.limits.map((limit) => [limit.id, limit.remaining])
}

describe("authorize and settle", () => {
  it("holds the estimate, consumes the actual, releases the rest", () => {
    const store = budgetWith(month100)

    const held = ok(store.run(authorize("k1", 80), t0))
    expect(held.outcome).toMatchObject({
      type: "authorize",
      holdId: "h_1",
      amount: $(80),
      expiresAt: t0 + 15 * minute,
      replayed: false,
      balance: { remaining: $(20), held: $(80) },
    })
    // The alarm comes back at the hold's expiry to settle it if the caller never does.
    expect(held.wakeAt).toBe(t0 + 15 * minute)

    const settled = ok(store.run(settle("h_1", 55), t0 + minute))
    expect(store.rows.get("h_1")).toMatchObject({
      state: {
        status: "settled",
        closedAt: t0 + minute,
        actual: $(55),
        crossed: [],
      },
    })
    expect(settled.outcome).toMatchObject({ released: $(25), expired: false, replayed: false })
    expect(remaining(settled)).toEqual([["month", $(45)]])
    expect(settled.wakeAt).toBe(t0 + minute + day)
  })

  it("rejects actual usage above its reservation without changing the hold", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 80), t0))
    const writes = store.writes
    expect(rejection(store.run(settle("h_1", 130), t0))).toEqual({
      code: "HOLD_AMOUNT_EXCEEDED",
      holdId: "h_1",
      maximum: $(80),
      actual: $(130),
    })
    expect([store.writes, store.ledger.held, store.ledger.usage.never.consumed]).toEqual([
      writes,
      $(80),
      $(0),
    ])
    expect(ok(store.run(settle("h_1", 80), t0)).outcome).toMatchObject({
      actual: $(80),
      released: $(0),
      balance: { remaining: $(20) },
    })
  })
})

describe("denials", () => {
  it("names the blocking limit, writes nothing, and lets the same key pass later", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 60), t0))
    const writes = store.writes

    expect(rejection(store.run(authorize("k2", 60), t0))).toMatchObject({
      code: "LIMIT_EXCEEDED",
      blocked: {
        limitId: "month",
        window: "month",
        remaining: $(40),
        held: $(60),
        resetsAt: nov1,
        remedy: "release_holds",
      },
    })
    expect([store.writes, store.ledger.held]).toEqual([writes, $(60)])

    ok(store.run(release("h_1"), t0))
    expect(ok(store.run(authorize("k2", 60), t0)).outcome).toMatchObject({ holdId: "h_2" })
  })

  it("blocks on the failing hard limit that resets last", () => {
    const store = budgetWith({
      limits: [
        { id: "daily", amount: "50", window: "day" },
        { id: "lifetime", amount: "100", window: "never" },
        { id: "alert", amount: "1", window: "hour", enforce: "soft" },
      ],
    })
    ok(store.run(charge("c1", 45), t0))

    expect(rejection(store.run(charge("c2", 10), t0))).toMatchObject({
      blocked: { limitId: "daily", resetsAt: oct15, remedy: "wait_for_reset", remaining: $(5) },
    })

    ok(store.run(charge("c3", 50), t0 + day))
    expect(rejection(store.run(charge("c4", 10), t0 + day))).toMatchObject({
      blocked: { limitId: "lifetime", resetsAt: null, remedy: "raise_limit", remaining: $(5) },
    })
  })

  it("asks to raise the limit when the request is larger than the limit itself", () => {
    const store = budgetWith(month100)
    expect(rejection(store.run(charge("c1", 101), t0))).toMatchObject({
      blocked: { limitId: "month", remedy: "raise_limit", remaining: $(100) },
    })
  })
})

describe("idempotency", () => {
  it("replays an authorize with the same key and request, and conflicts otherwise", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 80), t0))

    const replay = ok(store.run(authorize("k1", 80), t0 + minute))
    expect(replay.write).toBe(false)
    expect(replay.outcome).toMatchObject({
      holdId: "h_1",
      expiresAt: t0 + 15 * minute,
      replayed: true,
      balance: { remaining: $(20) },
    })

    expect(rejection(store.run(authorize("k1", 30), t0))).toEqual({
      code: "IDEMPOTENCY_CONFLICT",
      idempotencyKey: "k1",
    })
    expect(rejection(store.run(charge("k1", 80), t0)).code).toBe("IDEMPOTENCY_CONFLICT")
    expect(rejection(store.run(authorize("k1", 80, 15 * minute), t0)).code).toBe(
      "IDEMPOTENCY_CONFLICT"
    )
  })

  it("replays charge and record from their row", () => {
    const store = budgetWith({
      limits: [
        { id: "month", amount: "100", window: "month" },
        { id: "alert", amount: "50", window: "month", enforce: "soft" },
      ],
    })
    expect(ok(store.run(charge("c1", 60), t0)).outcome).toMatchObject({
      crossed: ["alert"],
      replayed: false,
    })

    const replay = ok(store.run(charge("c1", 60), t0))
    expect([replay.write, replay.outcome]).toMatchObject([
      false,
      {
        type: "charge",
        amount: $(60),
        crossed: ["alert"],
        replayed: true,
        balance: { remaining: $(40) },
      },
    ])
    expect(ok(store.run(record("r1", 5), t0)).outcome).toMatchObject({ replayed: false })
    expect(ok(store.run(record("r1", 5), t0)).outcome).toMatchObject({
      replayed: true,
      balance: { remaining: $(35) },
    })
  })

  it("keys settle and release by hold id", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 80), t0))
    ok(store.run(authorize("k2", 10), t0))
    ok(store.run(settle("h_1", 55), t0))

    const replay = ok(store.run(settle("h_1", 55), t0))
    expect([replay.write, replay.outcome]).toMatchObject([
      false,
      { actual: $(55), released: $(25), replayed: true },
    ])
    expect(rejection(store.run(settle("h_1", 56), t0))).toEqual({
      code: "HOLD_CLOSED",
      holdId: "h_1",
      status: "settled",
    })
    expect(rejection(store.run(release("h_1"), t0))).toMatchObject({
      code: "HOLD_CLOSED",
      status: "settled",
    })

    expect(ok(store.run(release("h_2"), t0)).outcome).toMatchObject({
      released: $(10),
      replayed: false,
    })
    expect(ok(store.run(release("h_2"), t0)).outcome).toMatchObject({
      released: $(10),
      replayed: true,
    })
    expect(rejection(store.run(settle("h_2", 1), t0))).toMatchObject({
      code: "HOLD_CLOSED",
      status: "released",
    })
  })

  it("rejects hold ids that were never minted", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 1), t0))
    ok(store.run(authorize("k2", 1), t0))

    expect(rejection(store.run(settle("h_3", 1), t0))).toEqual({
      code: "HOLD_NOT_FOUND",
      holdId: "h_3",
    })
    expect(rejection(store.run(settle("hold_1", 1), t0)).code).toBe("HOLD_NOT_FOUND")
    expect(rejection(store.run(release("h_3"), t0)).code).toBe("HOLD_NOT_FOUND")
  })
})

describe("expiry and final settlement", () => {
  it("derives expiry from the clock and still covers a settle after expiry", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 80, minute), t0))

    const read = ok(store.run({ type: "get" }, t0 + 2 * minute))
    expect([read.write, remaining(read)]).toEqual([false, [["month", $(20)]]])

    expect(ok(store.run(settle("h_1", 50), t0 + 2 * minute)).outcome).toMatchObject({
      actual: $(50),
      released: $(30),
      expired: true,
    })
  })

  it("settles an expired hold at its full amount, and the window reset returns the capacity", () => {
    const store = budgetWith({ limits: [{ id: "daily", amount: "100", window: "day" }] })
    ok(store.run(authorize("k1", 80, minute), t0))
    ok(store.run(authorize("k2", 10, hour), t0))
    const expiredAt = t0 + 2 * minute
    store.alarm(expiredAt)

    expect(store.rows.get("h_1")).toMatchObject({
      state: { status: "settled", closedAt: expiredAt, actual: $(80), crossed: [], byExpiry: true },
    })
    expect(store.rows.get("h_2")).toMatchObject({ state: { status: "open" } })
    expect([store.ledger.held, store.ledger.usage.day.consumed]).toEqual([$(10), $(80)])
    expect(rejection(store.run(charge("other", 11), expiredAt)).code).toBe("LIMIT_EXCEEDED")

    // A late settle of the full amount replays; anything else learns the hold expired.
    expect(ok(store.run(settle("h_1", 80), expiredAt)).outcome).toMatchObject({
      actual: $(80),
      released: $(0),
      expired: true,
      replayed: true,
    })
    const closed = { code: "HOLD_CLOSED", holdId: "h_1", status: "expired" }
    expect(rejection(store.run(settle("h_1", 70), expiredAt))).toEqual(closed)
    expect(rejection(store.run(release("h_1"), expiredAt))).toEqual(closed)

    ok(store.run(release("h_2"), expiredAt))
    expect(remaining(ok(store.run(charge("tomorrow", 100), t0 + day)))).toEqual([["daily", $(0)]])
  })

  it("settles expired holds earliest first, each crossing limits once", () => {
    const store = budgetWith({
      limits: [
        { id: "hard", amount: "100", window: "month" },
        { id: "soft", amount: "50", window: "month", enforce: "soft" },
      ],
    })
    ok(store.run(authorize("late", 30, 2 * minute), t0))
    ok(store.run(authorize("early", 40, minute), t0))
    const swept = ok(store.run({ type: "sweep" }, t0 + 3 * minute))

    expect(swept.operations.map((row) => [row.id, row.kind === "hold" && row.state])).toEqual([
      [
        "h_2",
        {
          status: "settled",
          closedAt: t0 + 3 * minute,
          actual: $(40),
          crossed: [],
          byExpiry: true,
        },
      ],
      [
        "h_1",
        {
          status: "settled",
          closedAt: t0 + 3 * minute,
          actual: $(30),
          crossed: ["soft"],
          byExpiry: true,
        },
      ],
    ])
    expect([swept.ledger.held, swept.ledger.usage.month.consumed]).toEqual([$(0), $(70)])
    expect(swept.wakeAt).toBe(t0 + 3 * minute + day)
  })

  it("counts a record past a hard limit and keeps holds, then denies gated spend", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 80, minute), t0))
    expect(ok(store.run(record("e1", 30), t0 + minute)).outcome).toMatchObject({
      amount: $(30),
      crossed: [],
      replayed: false,
      balance: { remaining: -$(10), held: $(80) },
    })
    expect(ok(store.run(settle("h_1", 70), t0 + minute)).outcome).toMatchObject({
      crossed: [],
      balance: { remaining: $(0), held: $(0) },
    })
    expect(ok(store.run(record("e2", 5), t0 + minute)).outcome).toMatchObject({
      crossed: ["month"],
      balance: { remaining: -$(5) },
    })
    expect(rejection(store.run(charge("c1", 1), t0 + minute))).toMatchObject({
      code: "LIMIT_EXCEEDED",
      blocked: { limitId: "month", remedy: "wait_for_reset" },
    })
  })

  it("lets an upsert keep or raise a hard limit a record passed, never lower it", () => {
    const store = budgetWith(month100)
    ok(store.run(record("e1", 120), t0))
    const daily = { id: "day", amount: "1000", window: "day" as const }
    ok(store.run(upsert({ limits: [...month100.limits, daily] }), t0))
    const lowered = { id: "month", amount: "90", window: "month" as const }
    expect(rejection(store.run(upsert({ limits: [lowered, daily] }), t0))).toMatchObject({
      code: "LIMIT_BELOW_USAGE",
      minimum: $(120),
      requested: $(90),
    })
    const raised = { id: "month", amount: "110", window: "month" as const }
    expect(remaining(ok(store.run(upsert({ limits: [raised, daily] }), t0)))).toEqual([
      ["month", -$(10)],
      ["day", $(880)],
    ])
  })

  it("retires a hold once its row is purged, so a retried settle never counts twice", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 80, minute), t0))
    ok(store.run(settle("h_1", 25), t0))
    ok(store.run(authorize("k2", 5, day), t0 + hour))
    ok(store.run({ type: "sweep" }, t0 + 3 * hour))
    const purgedAt = t0 + day
    store.alarm(purgedAt)
    expect(store.rows.size).toBe(1)

    expect(rejection(store.run(settle("h_1", 25), purgedAt))).toEqual({
      code: "HOLD_RETIRED",
      holdId: "h_1",
    })
    expect(ok(store.run(release("h_2"), purgedAt)).outcome).toMatchObject({ released: $(5) })
    expect(rejection(store.run(settle("h_3", 1), purgedAt)).code).toBe("HOLD_NOT_FOUND")
    expect(store.ledger.usage.never.consumed).toBe($(25))
  })
})

describe("who may loosen a budget", () => {
  const closesAt = t0 + day
  const base: BudgetConfigInput = {
    limits: [
      { id: "month", amount: "100", window: "month" },
      { id: "watch", amount: "10", window: "day", enforce: "soft" },
    ],
    closesAt,
  }
  const tighten = (input: BudgetConfigInput) => upsert(input, "money:USD", false)

  it("lets a caller that may not loosen create, repeat, and tighten a budget", () => {
    const store = new MemoryBudgetStore()
    ok(store.run(tighten(base), t0))
    ok(store.run(tighten(base), t0))
    const tightened = ok(
      store.run(
        tighten({
          limits: [
            { id: "month", amount: "80", window: "month" },
            { id: "watch", amount: "1000", window: "day" },
            { id: "hour", amount: "5", window: "hour" },
          ],
          holds: { defaultTtlMs: minute, maxTtlMs: day },
          closesAt: closesAt - hour,
        }),
        t0
      )
    )
    expect(tightened.outcome).toMatchObject({ budget: { version: 2, closesAt: closesAt - hour } })
  })

  it("refuses every change that lets more spend through, and writes nothing", () => {
    const store = budgetWith(base)
    const writes = store.writes
    const [month, watch] = base.limits
    const refused = (input: BudgetConfigInput) => rejection(store.run(tighten(input), t0))

    expect(refused({ ...base, limits: [{ ...month!, amount: "101" }, watch!] })).toEqual({
      code: "LOOSENING_FORBIDDEN",
      change: { change: "limit.amount", limitId: "month", from: $(100), to: $(101) },
    })
    expect(refused({ ...base, limits: [] })).toEqual({
      code: "LOOSENING_FORBIDDEN",
      change: { change: "limit.removed", limitId: "month" },
    })
    expect(refused({ ...base, limits: [{ ...month!, enforce: "soft" }, watch!] })).toEqual({
      code: "LOOSENING_FORBIDDEN",
      change: { change: "limit.enforce", limitId: "month", from: "hard", to: "soft" },
    })
    for (const later of [null, closesAt + 1]) {
      expect(refused({ ...base, closesAt: later })).toEqual({
        code: "LOOSENING_FORBIDDEN",
        change: { change: "closesAt" },
      })
    }
    expect(store.writes).toBe(writes)
    expect(
      ok(store.run(upsert({ ...base, limits: [], closesAt: null }), t0)).outcome
    ).toMatchObject({ budget: { version: 2, limits: [], closesAt: null } })
  })

  it("closes a budget no earlier than now, so a past close cannot bring its deletion forward", () => {
    const store = budgetWith(month100)
    const longAgo = t0 - 40 * day

    // Deleting the budget at once would let the same caller recreate it without its caps.
    const closed = ok(store.run(tighten({ ...month100, closesAt: longAgo }), t0))
    expect(closed.outcome).toMatchObject({ budget: { version: 2, closesAt: t0, closed: true } })
    expect(closed.wakeAt).toBe(t0 + CLOSED_BUDGET_RETENTION_MS)

    // Retried, or sent earlier still, the close stays where it took effect.
    for (const closesAt of [longAgo, t0 - hour]) {
      const repeated = ok(store.run(tighten({ ...month100, closesAt }), t0 + hour))
      expect(repeated.write).toBe(false)
      expect(repeated.outcome).toMatchObject({ budget: { version: 2, closesAt: t0 } })
    }

    // A caller that may loosen sets any close, past ones included.
    expect(
      ok(store.run(upsert({ ...month100, closesAt: longAgo }), t0 + hour)).outcome
    ).toMatchObject({ budget: { version: 3, closesAt: longAgo } })
  })
})

describe("operation counts", () => {
  it("counts each accepted call that changed the budget, per verb", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 10), t0))
    ok(store.run(authorize("k1", 10), t0))
    ok(store.run(settle("h_1", 4), t0))
    ok(store.run(settle("h_1", 4), t0))
    ok(store.run(authorize("k2", 5), t0))
    ok(store.run(release("h_2"), t0))
    ok(store.run(charge("c1", 1), t0))
    ok(store.run(charge("c1", 1), t0))
    ok(store.run(record("r1", 2), t0))
    rejection(store.run(authorize("k3", 1000), t0))
    ok(store.run(upsert(month100), t0))
    ok(store.run(upsert({ limits: [{ id: "month", amount: "90", window: "month" }] }), t0))
    // The alarm settling an expired hold is not a call.
    ok(store.run(authorize("k4", 1, minute), t0))
    store.alarm(t0 + 2 * minute)

    const read = ok(store.run({ type: "get" }, t0 + 2 * minute)).outcome
    expect(read).toMatchObject({
      budget: {
        operations: { upsert: 2, authorize: 3, settle: 1, release: 1, charge: 1, record: 1 },
      },
    })
    expect(store.ledger.operations).toEqual(read.type === "get" ? read.budget.operations : null)
  })
})

describe("time and config never reset usage", () => {
  it("does not reopen a window when the clock goes backwards", () => {
    const store = budgetWith(month100, Date.parse("2026-10-31T23:00:00.000Z"))
    ok(store.run(charge("a", 90), Date.parse("2026-10-31T23:59:59.000Z")))
    ok(store.run(charge("b", 90), Date.parse("2026-11-01T00:00:00.001Z")))

    const behind = Date.parse("2026-10-31T23:59:59.500Z")
    expect(rejection(store.run(charge("c", 90), behind))).toMatchObject({
      blocked: { limitId: "month", remaining: $(10) },
    })
    const recorded = ok(store.run(record("d", 5, behind), behind))
    expect(recorded.now).toBe(Date.parse("2026-11-01T00:00:00.001Z"))
    expect(remaining(recorded)).toEqual([["month", $(5)]])
  })

  it("keeps consumption across rename, a new id on another window, and remove then re-add", () => {
    const store = budgetWith({ limits: [{ id: "monthly", amount: "100", window: "month" }] })
    ok(store.run(charge("c1", 60), t0))

    const renamed = ok(
      store.run(upsert({ limits: [{ id: "cap", amount: "100", window: "month" }] }), t0)
    )
    expect(renamed.outcome).toMatchObject({
      changes: [
        { change: "limit.added", limitId: "cap" },
        { change: "limit.removed", limitId: "monthly" },
      ],
      budget: { version: 2 },
    })
    expect(remaining(renamed)).toEqual([["cap", $(40)]])

    // Calendar counters always run, so a new id on the day window starts with the day's usage.
    const daily = ok(
      store.run(upsert({ limits: [{ id: "daily", amount: "100", window: "day" }] }), t0)
    )
    expect(remaining(daily)).toEqual([["daily", $(40)]])

    ok(store.run(upsert({ limits: [] }), t0))
    const readded = ok(
      store.run(upsert({ limits: [{ id: "cap", amount: "100", window: "month" }] }), t0)
    )
    expect(remaining(readded)).toEqual([["cap", $(40)]])
    expect(readded.outcome).toMatchObject({ budget: { version: 5 } })
  })

  it("rejects hard caps below consumed and reserved amounts", () => {
    const store = budgetWith(month100)
    ok(store.run(charge("spent", 40), t0))
    ok(store.run(authorize("pending", 50), t0))
    const writes = store.writes
    for (const limits of [
      [{ id: "month", amount: "80", window: "month" as const }],
      [{ id: "new", amount: "80", window: "month" as const }],
    ]) {
      expect(rejection(store.run(upsert({ limits }), t0))).toMatchObject({
        code: "LIMIT_BELOW_USAGE",
        minimum: $(90),
        requested: $(80),
      })
    }
    expect(store.writes).toBe(writes)
    const soft = budgetWith({
      limits: [{ id: "cap", amount: "20", window: "month", enforce: "soft" }],
    })
    ok(soft.run(charge("spent", 40), t0))
    expect(
      rejection(soft.run(upsert({ limits: [{ id: "cap", amount: "20", window: "month" }] }), t0))
        .code
    ).toBe("LIMIT_BELOW_USAGE")
  })

  it("refuses to move a limit id to another window and writes nothing", () => {
    const store = budgetWith({ limits: [{ id: "cap", amount: "100", window: "month" }] })
    ok(store.run(charge("c1", 60), t0))
    const writes = store.writes

    expect(
      rejection(store.run(upsert({ limits: [{ id: "cap", amount: "100", window: "day" }] }), t0))
    ).toEqual({
      code: "LIMIT_WINDOW_IMMUTABLE",
      limitId: "cap",
      current: "month",
      requested: "day",
    })
    expect(store.writes).toBe(writes)

    // The amount and enforcement under the same id still change.
    const raised = ok(
      store.run(
        upsert({ limits: [{ id: "cap", amount: "500", window: "month", enforce: "soft" }] }),
        t0
      )
    )
    expect(raised.outcome).toMatchObject({
      changes: [
        { change: "limit.amount", limitId: "cap", from: $(100), to: $(500) },
        { change: "limit.enforce", limitId: "cap", from: "hard", to: "soft" },
      ],
    })
    expect(remaining(raised)).toEqual([["cap", $(440)]])
  })

  it("converges an identical upsert without writing", () => {
    const store = budgetWith(month100)
    const again = ok(store.run(upsert(month100), t0))
    expect([again.write, again.outcome]).toMatchObject([
      false,
      { changes: [], budget: { version: 1 } },
    ])
    expect(rejection(store.run(upsert(month100, "money:EUR"), t0))).toEqual({
      code: "UNIT_IMMUTABLE",
      current: "money:USD",
      requested: "money:EUR",
    })
  })

  it("rejects every verb but upsert before the budget exists", () => {
    const store = new MemoryBudgetStore()
    expect(rejection(store.run({ type: "get" }, t0))).toEqual({ code: "BUDGET_NOT_FOUND" })
    expect(rejection(store.run(record("r1", 1), t0))).toEqual({ code: "BUDGET_NOT_FOUND" })
  })

  it("resets a week window on Monday 00:00 UTC", () => {
    const sunday = Date.parse("2026-10-18T23:00:00.000Z")
    const store = budgetWith({ limits: [{ id: "weekly", amount: "100", window: "week" }] }, sunday)
    const charged = ok(store.run(charge("c1", 70), sunday))
    expect(charged.outcome).toMatchObject({
      balance: { limits: [{ remaining: $(30), resetsAt: Date.parse("2026-10-19T00:00:00.000Z") }] },
    })

    const monday = ok(store.run({ type: "get" }, Date.parse("2026-10-19T00:00:00.000Z")))
    expect(monday.outcome).toMatchObject({
      budget: {
        balance: { limits: [{ consumed: $(0), resetsAt: Date.parse("2026-10-26T00:00:00.000Z") }] },
      },
    })
  })
})

describe("closesAt", () => {
  it("wakes the alarm for when a closed budget may delete its storage", () => {
    const store = new MemoryBudgetStore()
    const closesAt = t0 + hour
    expect(ok(store.run(upsert({ ...month100, closesAt }), t0)).wakeAt).toBe(
      closesAt + CLOSED_BUDGET_RETENTION_MS
    )
    expect(ok(store.run(upsert({ ...month100, closesAt: null }), t0)).wakeAt).toBeNull()
  })

  it("refuses new spend from closesAt, keeps settling and releasing, and takes records a day more", () => {
    const closesAt = t0 + hour
    const store = budgetWith({ ...month100, closesAt })
    ok(store.run(authorize("k1", 30, 2 * hour), t0))
    ok(store.run(authorize("k2", 10, 2 * hour), t0))
    expect(ok(store.run({ type: "get" }, closesAt - 1)).outcome).toMatchObject({
      budget: { closesAt, closed: false },
    })

    const closed = { code: "BUDGET_CLOSED", closedAt: closesAt }
    expect(rejection(store.run(authorize("k3", 1), closesAt))).toEqual(closed)
    expect(rejection(store.run(charge("c1", 1), closesAt))).toEqual(closed)
    expect(ok(store.run(authorize("k1", 30, 2 * hour), closesAt)).outcome).toMatchObject({
      holdId: "h_1",
      replayed: true,
    })
    expect(ok(store.run(settle("h_1", 25), closesAt)).outcome).toMatchObject({
      actual: $(25),
      released: $(5),
      replayed: false,
    })
    expect(ok(store.run(release("h_2"), closesAt)).outcome).toMatchObject({ released: $(10) })
    expect(ok(store.run(record("r1", 5), closesAt + day - 1)).outcome).toMatchObject({
      replayed: false,
    })
    expect(rejection(store.run(record("r2", 5), closesAt + day))).toEqual(closed)

    expect(ok(store.run({ type: "get" }, closesAt + day)).outcome).toMatchObject({
      budget: { closesAt, closed: true, balance: { held: $(0), limits: [{ consumed: $(30) }] } },
    })

    const reopened = ok(store.run(upsert({ ...month100, closesAt: null }), closesAt + day))
    expect(reopened.outcome).toMatchObject({
      changes: [{ change: "closesAt" }],
      budget: { closesAt: null, closed: false, version: 2 },
    })
    expect(ok(store.run(charge("c1", 1), closesAt + day)).outcome).toMatchObject({
      replayed: false,
    })
  })
})

describe("anchored windows", () => {
  const anchor = Date.parse("2026-10-15T00:00:00.000Z")
  const withBilling: BudgetConfigInput = {
    limits: [
      { id: "month", amount: "100", window: "month" },
      { id: "billing", amount: "100", window: "month", anchor },
    ],
  }

  it("counts from when the anchor is added and keeps counting across remove and re-add", () => {
    const store = budgetWith(month100)
    ok(store.run(charge("c1", 10), t0))

    const added = ok(store.run(upsert(withBilling), t0))
    expect(added.outcome).toMatchObject({
      changes: [{ change: "limit.added", limitId: "billing" }],
    })
    expect(remaining(added)).toEqual([
      ["month", $(90)],
      ["billing", $(100)],
    ])
    ok(store.run(charge("c2", 20), t0))
    ok(store.run(upsert(month100), t0 + hour))

    const readded = ok(store.run(upsert(withBilling), t0 + 2 * hour))
    expect(remaining(readded)).toEqual([
      ["month", $(70)],
      ["billing", $(80)],
    ])
    expect(readded.outcome).toMatchObject({
      budget: { balance: { limits: [{ resetsAt: nov1 }, { resetsAt: oct15 }] } },
    })
  })

  it("drops an unreferenced anchor when its period ends, so a later re-add starts from zero", () => {
    const store = budgetWith(withBilling)
    ok(store.run(charge("c1", 20), t0))
    ok(store.run(upsert(month100), t0 + hour))

    const readded = ok(store.run(upsert(withBilling), oct15 + hour))
    expect(remaining(readded)).toEqual([
      ["month", $(80)],
      ["billing", $(100)],
    ])
    // No limit used the anchor or the day window when their periods ended, so neither reports.
    expect([readded.periods, store.history.size]).toEqual([[], 0])
  })

  it("refuses an anchor move under the same id, which would restart the count at zero", () => {
    const store = budgetWith(withBilling)
    const moved = store.run(
      upsert({
        limits: [
          { id: "month", amount: "100", window: "month" },
          {
            id: "billing",
            amount: "100",
            window: "month",
            anchor: Date.parse("2026-10-01T00:00:00Z"),
          },
        ],
      }),
      t0
    )
    expect(rejection(moved)).toEqual({
      code: "LIMIT_WINDOW_IMMUTABLE",
      limitId: "billing",
      current: "month@1970-01-15T00:00:00.000Z",
      requested: "month@1970-01-01T00:00:00.000Z",
    })
  })
})

describe("window history", () => {
  const daily50: BudgetConfigInput = { limits: [{ id: "daily", amount: "50", window: "day" }] }
  const oct14 = Date.parse("2026-10-14T00:00:00.000Z")

  it("rolls a limited window's period with usage into its history, inside an accepted command only", () => {
    const store = new MemoryBudgetStore()
    // No wake at the boundary: the next command rolls the period the same however late it comes.
    expect(ok(store.run(upsert(daily50), t0)).wakeAt).toBeNull()
    ok(store.run(charge("c1", 20), t0))

    expect(rejection(store.run(charge("big", 51), t0 + day)).code).toBe("LIMIT_EXCEEDED")
    expect(store.history.size).toBe(0)

    const read = ok(store.run({ type: "get" }, t0 + 3 * day))
    // The hour counter rolls too, but no limit uses it, so it keeps no history.
    expect(read.periods).toEqual([{ windowId: "day", start: oct14, end: oct15, consumed: $(20) }])
    expect(read.outcome).toMatchObject({
      history: [{ windowId: "day", start: oct14, end: oct15, consumed: $(20) }],
      budget: { balance: { limits: [{ consumed: $(0), remaining: $(50) }] } },
    })
    expect(ok(store.run({ type: "get" }, t0 + 3 * day)).write).toBe(false)
  })

  it("keeps and returns the last twelve periods of each window, newest first", () => {
    const store = budgetWith(daily50)
    for (let i = 0; i < 14; i++) ok(store.run(charge(`c${i}`, i + 1), t0 + i * day))

    const read = ok(store.run({ type: "get" }, t0 + 14 * day)).outcome
    if (read.type !== "get") throw new Error("expected get")
    expect(read.history.map((period) => [period.start, period.consumed])).toEqual(
      Array.from({ length: 12 }, (_, i) => [oct14 + (13 - i) * day, $(14 - i)])
    )
    expect([store.history.get("day")?.length, store.history.has("hour")]).toEqual([12, false])
  })
})

describe("record dedupe", () => {
  it("accepts usage from the last 7 days up to 5 minutes ahead", () => {
    const store = budgetWith(month100)
    expect(rejection(store.run(record("r1", 1, t0 - 7 * day - 1), t0))).toEqual({
      code: "TOO_LATE",
      occurredAt: t0 - 7 * day - 1,
      oldestAccepted: t0 - 7 * day,
    })
    expect(rejection(store.run(record("r1", 1, t0 + 5 * minute + 1), t0))).toEqual({
      code: "INVALID_OCCURRED_AT",
      occurredAt: t0 + 5 * minute + 1,
      latestAccepted: t0 + 5 * minute,
    })
    expect(store.writes).toBe(1)

    expect(ok(store.run(record("r1", 1, t0 - 7 * day), t0)).outcome).toMatchObject({
      replayed: false,
    })
    const ahead = ok(store.run(record("r2", 2, t0 + 5 * minute), t0))
    expect([ahead.now, remaining(ahead)]).toEqual([t0, [["month", $(97)]]])
  })

  it("replays a retry with another occurredAt, and conflicts on another amount", () => {
    const store = budgetWith(month100)
    ok(store.run(record("r1", 30), t0))

    const retried = ok(store.run(record("r1", 30, t0 + minute), t0 + minute))
    expect([retried.outcome, retried.write]).toMatchObject([{ replayed: true }, false])
    expect(rejection(store.run(record("r1", 31), t0 + minute)).code).toBe("IDEMPOTENCY_CONFLICT")
  })

  it("keeps a record's row for 8 days, then refuses the replay as too late", () => {
    const store = budgetWith({ limits: [{ id: "life", amount: "100", window: "never" }] })
    ok(store.run(record("r1", 30), t0))
    ok(store.run(record("r2", 70), t0))

    store.alarm(t0 + day)
    expect([...store.rows.keys()]).toEqual(["o:r1", "o:r2"])
    expect(ok(store.run(record("r2", 70), t0 + 6 * day)).outcome).toMatchObject({
      type: "record",
      amount: $(70),
      crossed: [],
      replayed: true,
      balance: { remaining: $(0) },
    })
    expect(rejection(store.run(record("r1", 31), t0 + 6 * day)).code).toBe("IDEMPOTENCY_CONFLICT")
    expect(rejection(store.run(charge("r1", 30), t0 + 6 * day)).code).toBe("IDEMPOTENCY_CONFLICT")

    store.alarm(t0 + 8 * day)
    expect(store.rows.size).toBe(0)
    expect(rejection(store.run(record("r1", 30), t0 + 8 * day)).code).toBe("TOO_LATE")
  })

  it("stops answering from a row when its retention ends, even before the alarm purges it", () => {
    const store = budgetWith(month100)
    ok(store.run(record("r1", 30), t0))

    const reused = ok(store.run(record("r1", 5, t0 + 8 * day), t0 + 8 * day))
    expect(reused.outcome).toMatchObject({ amount: $(5), replayed: false })
    expect([store.rows.size, store.rows.get("o:r1")?.amount]).toEqual([1, $(5)])
  })
})

describe("amounts and crossings", () => {
  it("adds amounts above 2^53 base units exactly", () => {
    const store = new MemoryBudgetStore()
    ok(
      store.run(
        upsert(
          { limits: [{ id: "tokens", amount: "50000000000", window: "never" }] },
          "units:tokens"
        ),
        t0
      )
    )

    const charged = ok(store.run(oneShot("charge", "c1", BigInt("3000000000000000001")), t0))
    expect(remaining(charged)).toEqual([["tokens", BigInt("1999999999999999999")]])
    expect(formatAmount(BigInt("1999999999999999999"))).toBe("19999999999.99999999")
  })

  it("reports a crossing once, and again after the window resets", () => {
    const store = budgetWith({
      limits: [
        { id: "month", amount: "100", window: "month" },
        { id: "alerts", amount: "10", window: "day", enforce: "soft" },
      ],
    })
    const crossed = (key: string, units: number, at: number) => {
      const outcome = ok(store.run(record(key, units), at)).outcome
      return "crossed" in outcome ? outcome.crossed : null
    }
    expect(crossed("r1", 8, t0)).toEqual([])
    expect(crossed("r2", 5, t0)).toEqual(["alerts"])
    expect(crossed("r3", 5, t0)).toEqual([])
    expect(crossed("r4", 11, t0 + day)).toEqual(["alerts"])
  })

  it("rejects out-of-range TTLs and refuses to commit a negative amount", () => {
    const store = budgetWith({ ...month100, holds: { maxTtlMs: hour } })
    expect(rejection(store.run(authorize("k1", 1, 500), t0))).toEqual({
      code: "INVALID_TTL",
      ttlMs: 500,
      minTtlMs: 1_000,
      maxTtlMs: hour,
    })
    expect(rejection(store.run(authorize("k2", 1, hour + 1), t0)).code).toBe("INVALID_TTL")
    expect(() => store.run(oneShot("record", "r1", BigInt(-1)), t0)).toThrow(
      "budget transition breaks invariants"
    )
  })
})

describe("config schema", () => {
  it("fills defaults and round-trips through its JSON form", () => {
    const parsed = config({
      limits: [
        { id: "m", amount: "12.5", window: "month" },
        { id: "billing", amount: "1", window: "month", anchor: Date.parse("2026-10-15T07:30:00Z") },
      ],
      onUnavailable: "deny",
      closesAt: Date.parse("2026-12-31T23:59:59Z"),
    })
    expect(parsed).toEqual({
      limits: [
        { id: "m", amount: BigInt(1_250_000_000), window: "month", enforce: "hard" },
        {
          id: "billing",
          amount: BigInt(100_000_000),
          window: "month",
          anchor: Date.parse("2026-10-15T07:30:00.000Z"),
          enforce: "hard",
        },
      ],
      holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
      onUnavailable: "deny",
      closesAt: Date.parse("2026-12-31T23:59:59.000Z"),
    })
    expect(formatBudgetConfig(parsed)).toEqual({
      limits: [
        { id: "m", amount: "12.5", window: "month", enforce: "hard" },
        {
          id: "billing",
          amount: "1",
          window: "month",
          anchor: Date.parse("2026-10-15T07:30:00.000Z"),
          enforce: "hard",
        },
      ],
      holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
      onUnavailable: "deny",
      closesAt: Date.parse("2026-12-31T23:59:59.000Z"),
    })
    expect(config(formatBudgetConfig(parsed))).toEqual(parsed)
    expect(config({ limits: [] }).closesAt).toBe(null)
  })

  it("rejects fail-open policies at the boundary", () => {
    for (const onUnavailable of ["allow", { allowUpTo: "1" }]) {
      expect(
        upsertBudgetInputSchema.safeParse({ key: "k", unit: "USD", limits: [], onUnavailable })
          .success
      ).toBe(false)
    }
    expect(config({ limits: [] }).onUnavailable).toBe("deny")
  })

  it("rejects duplicate ids, bad amounts, and inverted TTL bounds", () => {
    expect(
      issues({
        limits: [
          { id: "a", amount: "1.123456789", window: "day" },
          { id: "b", amount: "99999999999", window: "day" },
        ],
      })
    ).toEqual([
      "limits.0.amount: a non-negative decimal string with at most 8 decimal places",
      "limits.1.amount: invalid amount: too_large",
    ])

    expect(
      issues({
        limits: [
          { id: "a", amount: "1", window: "day" },
          { id: "a", amount: "2", window: "day" },
        ],
        holds: { defaultTtlMs: hour, maxTtlMs: minute },
      })
    ).toEqual([
      "limits.1.id: duplicate limit id a",
      "holds.defaultTtlMs: defaultTtlMs must not exceed maxTtlMs",
    ])

    expect(
      issues({
        limits: [
          { id: "h", amount: "1", window: "hour", anchor: Date.parse("2026-10-15T00:00:00Z") },
          { id: "d", amount: "1", window: "day", anchor: 1.5 },
        ],
        closesAt: -1,
      })
    ).toEqual([
      "limits.0.anchor: only day, week, and month windows take an anchor",
      "limits.1.anchor: Expected integer, received float",
      "closesAt: Number must be greater than or equal to 0",
    ])
  })
})

describe("checkTransition", () => {
  it("catches a settle that keeps the unused part of the hold held", () => {
    const hold: HoldOperation = {
      kind: "hold",
      id: "h_1",
      idempotencyKey: "k1",
      amount: $(80),
      ttlMs: minute,
      createdAt: t0,
      expiresAt: t0 + minute,
      state: { status: "open" },
    }
    const settled: HoldOperation = {
      ...hold,
      state: { status: "settled", closedAt: t0, actual: $(55), crossed: [] },
    }
    const before = { ...emptyLedger, lastAt: t0, holdSeq: 1, held: $(80) }
    const after = { ...before, held: $(25), usage: consume(before.usage, $(55)) }
    expect(
      checkTransition({
        before,
        after,
        limits: [],
        resultingLimits: [],
        steps: [[hold, settled]],
        periods: [],
      })
    ).toEqual(["ledger held moved -5500000000, rows say -8000000000"])
  })

  it("catches a settle above its hold", () => {
    const hold: HoldOperation = {
      kind: "hold",
      id: "h_1",
      idempotencyKey: "k1",
      amount: $(80),
      ttlMs: minute,
      createdAt: t0,
      expiresAt: t0 + minute,
      state: { status: "open" },
    }
    const settled: HoldOperation = {
      ...hold,
      state: { status: "settled", closedAt: t0, actual: $(90), crossed: [] },
    }
    const before = { ...emptyLedger, lastAt: t0, holdSeq: 1, held: $(80) }
    const after = { ...before, held: $(0), usage: consume(before.usage, $(90)) }
    expect(
      checkTransition({
        before,
        after,
        limits: [],
        resultingLimits: [],
        steps: [[hold, settled]],
        periods: [],
      })
    ).toEqual(["row h_1 settled 9000000000 of 8000000000"])
  })
})

describe("history does not slow the hot path", () => {
  it("decides in under 1 ms with 50,000 closed operations behind the ledger", () => {
    let state: BudgetView = {
      budget: null,
      ledger: emptyLedger,
      target: null,
      history: [],
      expiredHolds: [],
    }
    const first = transition({ view: state, command: upsert(month100), clockMs: t0 })
    if (first.err) throw first.err
    state = { ...state, budget: first.val.budget, ledger: first.val.ledger }

    for (let i = 0; i < 50_000; i++) {
      const placed = transition({ view: state, command: authorize(`k${i}`, 0), clockMs: t0 + i })
      if (placed.err) throw placed.err
      const hold = placed.val.operations[0] ?? null
      const settled = transition({
        view: { ...state, ledger: placed.val.ledger, target: hold },
        command: settle(hold?.id ?? "", 0),
        clockMs: t0 + i,
      })
      if (settled.err) throw settled.err
      state = { ...state, ledger: settled.val.ledger }
    }
    expect(state.ledger.holdSeq).toBe(50_000)

    const runs = 1_000
    const started = performance.now()
    for (let i = 0; i < runs; i++) {
      const result = transition({ view: state, command: authorize(`p${i}`, 1), clockMs: t0 + day })
      if (result.err) throw result.err
    }
    expect((performance.now() - started) / runs).toBeLessThan(1)
  }, 60_000)
})
