import { formatAmount } from "@unprice/money"
import { describe, expect, it } from "vitest"
import {
  type BudgetCommand,
  type BudgetConfigInput,
  type BudgetState,
  type BudgetTransition,
  type Entry,
  type HoldOperation,
  checkTransition,
  emptyLedger,
  evolve,
  formatBudgetConfig,
  parseBudgetConfig,
  requestFingerprint,
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

function config(input: BudgetConfigInput) {
  const parsed = parseBudgetConfig(input)
  if (parsed.err) throw parsed.err
  return parsed.val
}

function upsert(input: BudgetConfigInput, unit = "money:USD"): BudgetCommand {
  return { type: "upsert", key: "customer:acme", projectId: "proj_1", unit, config: config(input) }
}

function authorize(key: string, units: number, ttlMs?: number): BudgetCommand {
  const cost = { amount: $(units) }
  return {
    type: "authorize",
    idempotencyKey: key,
    cost,
    ttlMs,
    requestHash: requestFingerprint({ type: "authorize", cost, ttlMs }),
  }
}

function oneShot(
  type: "charge" | "record",
  key: string,
  amount: bigint,
  occurredAt = t0
): BudgetCommand {
  const cost = { amount }
  const requestHash = requestFingerprint({ type, cost })
  if (type === "charge") return { type, idempotencyKey: key, cost, requestHash }
  return { type, idempotencyKey: key, cost, occurredAt, requestHash }
}

const charge = (key: string, units: number) => oneShot("charge", key, $(units))
const record = (key: string, units: number, occurredAt = t0) =>
  oneShot("record", key, $(units), occurredAt)
const settle = (holdId: string, units: number): BudgetCommand => ({
  type: "settle",
  holdId,
  cost: { amount: $(units) },
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
    expect(held.wakeAt).toBe(t0 + 45 * minute)

    const settled = ok(store.run(settle("h_1", 55), t0 + minute))
    expect(settled.entries).toEqual([
      {
        type: "hold.settled",
        holdId: "h_1",
        actual: $(55),
        covered: $(55),
        released: $(25),
        overrun: $(0),
        late: false,
        crossed: [],
        seq: 3,
        at: t0 + minute,
      },
    ])
    expect(settled.outcome).toMatchObject({ late: false, expired: false, replayed: false })
    expect(remaining(settled)).toEqual([["month", $(45)]])
    expect(settled.wakeAt).toBe(t0 + minute + day)
  })

  it("consumes an actual above the hold as overrun and reports the crossing", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 80), t0))

    const settled = ok(store.run(settle("h_1", 130), t0))
    expect(settled.outcome).toMatchObject({
      covered: $(80),
      released: $(0),
      overrun: $(50),
      crossed: ["month"],
      balance: { remaining: $(-30) },
    })
  })
})

describe("denials", () => {
  it("names the blocking limit, writes nothing, and lets the same key pass later", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 60), t0))
    const seqBefore = store.ledger.seq

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
    expect([store.ledger.seq, store.entries.length]).toEqual([seqBefore, 2])

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
    expect(replay.entries).toEqual([])
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
    expect([replay.entries.length, replay.outcome]).toMatchObject([
      0,
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
    expect([replay.entries.length, replay.outcome]).toMatchObject([
      0,
      { covered: $(55), released: $(25), replayed: true },
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

describe("expiry, lapse, and late usage", () => {
  it("derives expiry from the clock and still covers a settle after expiry", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 80, minute), t0))

    const read = ok(store.run({ type: "get" }, t0 + 2 * minute))
    expect([read.entries.length, remaining(read)]).toEqual([0, [["month", $(20)]]])

    expect(ok(store.run(settle("h_1", 50), t0 + 2 * minute)).outcome).toMatchObject({
      covered: $(50),
      released: $(30),
      late: false,
      expired: true,
    })
  })

  it("lapses after twice the TTL past expiry, then consumes a late settle", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 80, minute), t0))

    const swept = ok(store.run({ type: "sweep" }, t0 + 3 * minute))
    expect(swept.outcome).toEqual({ type: "sweep", lapsed: 1 })
    expect(swept.entries).toEqual([
      { type: "hold.lapsed", holdId: "h_1", released: $(80), seq: 3, at: t0 + 3 * minute },
    ])
    expect(swept.wakeAt).toBe(t0 + 3 * minute + day)

    const late = ok(store.run(settle("h_1", 30), t0 + 4 * minute))
    expect(late.outcome).toMatchObject({
      covered: $(0),
      released: $(0),
      overrun: $(30),
      late: true,
      expired: true,
      balance: { remaining: $(70), held: $(0) },
    })
  })

  it("lapses a due hold inside any accepted command, but not inside a denial", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 80, minute), t0))

    rejection(store.run(charge("c1", 101), t0 + 3 * minute))
    expect(store.ledger.held).toBe($(80))

    const charged = ok(store.run(charge("c2", 90), t0 + 3 * minute))
    expect(charged.entries.map((entry) => entry.type)).toEqual(["hold.lapsed", "charged"])
    expect(remaining(charged)).toEqual([["month", $(10)]])
  })

  it("retires a hold once its row is purged, so a retried settle never counts twice", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 80, minute), t0))
    ok(store.run(authorize("k2", 5, minute), t0))
    ok(store.run(settle("h_1", 25), t0))
    ok(store.run({ type: "sweep" }, t0 + 3 * minute))
    const purgedAt = t0 + 3 * minute + day
    store.purge(purgedAt)
    expect(store.rows.size).toBe(0)

    expect(rejection(store.run(settle("h_1", 25), purgedAt))).toEqual({
      code: "HOLD_RETIRED",
      holdId: "h_1",
    })
    expect(rejection(store.run(settle("h_2", 1), purgedAt)).code).toBe("HOLD_RETIRED")
    expect(rejection(store.run(release("h_2"), purgedAt)).code).toBe("HOLD_RETIRED")
    expect(rejection(store.run(settle("h_3", 1), purgedAt)).code).toBe("HOLD_NOT_FOUND")
    expect(store.ledger.usage.never.consumed).toBe($(25))
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
    expect(recorded.entries[0]?.at).toBe(Date.parse("2026-11-01T00:00:00.001Z"))
    expect(remaining(recorded)).toEqual([["month", $(5)]])
  })

  it("keeps consumption across rename, window change, and remove then re-add", () => {
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

    const rewindowed = ok(
      store.run(upsert({ limits: [{ id: "cap", amount: "100", window: "day" }] }), t0)
    )
    expect(rewindowed.outcome).toMatchObject({
      changes: [{ change: "limit.window", limitId: "cap", from: "month", to: "day" }],
    })
    expect(remaining(rewindowed)).toEqual([["cap", $(40)]])

    ok(store.run(upsert({ limits: [] }), t0))
    const readded = ok(
      store.run(upsert({ limits: [{ id: "cap", amount: "100", window: "month" }] }), t0)
    )
    expect(remaining(readded)).toEqual([["cap", $(40)]])
    expect(readded.outcome).toMatchObject({ budget: { version: 5 } })
  })

  it("converges an identical upsert without writing", () => {
    const store = budgetWith(month100)
    const again = ok(store.run(upsert(month100), t0))
    expect([again.entries.length, again.outcome]).toMatchObject([
      0,
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
  it("refuses new spend from closesAt, keeps settling and releasing, and takes records a day more", () => {
    const closesAt = t0 + hour
    const store = budgetWith({ ...month100, closesAt: new Date(closesAt).toISOString() })
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
      covered: $(25),
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
  const anchor = "2026-10-15T00:00:00.000Z"
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
    expect(readded.entries.filter((entry) => entry.type === "window.rolled")).toEqual([
      {
        type: "window.rolled",
        windowId: "day",
        start: Date.parse("2026-10-14T00:00:00.000Z"),
        end: oct15,
        consumed: $(20),
        seq: 5,
        at: oct15 + hour,
      },
      {
        type: "window.rolled",
        windowId: "month@2026-10-15T00:00:00.000Z",
        start: Date.parse("2026-09-15T00:00:00.000Z"),
        end: oct15,
        consumed: $(20),
        seq: 6,
        at: oct15 + hour,
      },
    ])
  })

  it("names an anchor move as a window change", () => {
    const store = budgetWith(withBilling)
    const moved = ok(
      store.run(
        upsert({
          limits: [
            { id: "month", amount: "100", window: "month" },
            { id: "billing", amount: "100", window: "month", anchor: "2026-10-01T00:00:00Z" },
          ],
        }),
        t0
      )
    )
    expect(moved.outcome).toMatchObject({
      changes: [
        {
          change: "limit.window",
          limitId: "billing",
          from: "month@2026-10-15T00:00:00.000Z",
          to: "month@2026-10-01T00:00:00.000Z",
        },
      ],
    })
  })
})

describe("window history", () => {
  const daily50: BudgetConfigInput = { limits: [{ id: "daily", amount: "50", window: "day" }] }
  const oct14 = Date.parse("2026-10-14T00:00:00.000Z")

  it("rolls a period with usage into one fact, inside an accepted command only", () => {
    const store = new MemoryBudgetStore()
    // No wake at the boundary: the next command rolls the period the same however late it comes.
    expect(ok(store.run(upsert(daily50), t0)).wakeAt).toBeNull()
    ok(store.run(charge("c1", 20), t0))

    expect(rejection(store.run(charge("big", 51), t0 + day)).code).toBe("LIMIT_EXCEEDED")
    expect(store.history.size).toBe(0)

    const read = ok(store.run({ type: "get" }, t0 + 3 * day))
    expect(read.entries).toEqual([
      {
        type: "window.rolled",
        windowId: "hour",
        start: t0,
        end: t0 + hour,
        consumed: $(20),
        seq: 3,
        at: t0 + 3 * day,
      },
      {
        type: "window.rolled",
        windowId: "day",
        start: oct14,
        end: oct15,
        consumed: $(20),
        seq: 4,
        at: t0 + 3 * day,
      },
    ])
    expect(read.outcome).toMatchObject({
      history: [{ windowId: "day", start: oct14, end: oct15, consumed: $(20) }],
      budget: { balance: { limits: [{ consumed: $(0), remaining: $(50) }] } },
    })
    expect(ok(store.run({ type: "get" }, t0 + 3 * day)).entries).toEqual([])
  })

  it("keeps and returns the last twelve periods of each window, newest first", () => {
    const store = budgetWith(daily50)
    for (let i = 0; i < 14; i++) ok(store.run(charge(`c${i}`, i + 1), t0 + i * day))

    const read = ok(store.run({ type: "get" }, t0 + 14 * day)).outcome
    if (read.type !== "get") throw new Error("expected get")
    expect(read.history.map((period) => [period.start, period.consumed])).toEqual(
      Array.from({ length: 12 }, (_, i) => [oct14 + (13 - i) * day, $(14 - i)])
    )
    expect([store.history.get("day")?.length, store.history.get("hour")?.length]).toEqual([12, 12])
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
    expect(store.entries.length).toBe(1)

    expect(ok(store.run(record("r1", 1, t0 - 7 * day), t0)).outcome).toMatchObject({
      replayed: false,
    })
    const ahead = ok(store.run(record("r2", 2, t0 + 5 * minute), t0))
    expect([ahead.entries[0]?.at, remaining(ahead)]).toEqual([t0, [["month", $(97)]]])
  })

  it("replays a retry with another occurredAt, and conflicts on another amount", () => {
    const store = budgetWith(month100)
    ok(store.run(record("r1", 30), t0))

    const retried = ok(store.run(record("r1", 30, t0 + minute), t0 + minute))
    expect([retried.outcome, retried.entries]).toMatchObject([{ replayed: true }, []])
    expect(rejection(store.run(record("r1", 31), t0 + minute)).code).toBe("IDEMPOTENCY_CONFLICT")
  })

  it("answers from the receipt for 8 days after the row is purged, then refuses the replay", () => {
    // Receipts are purged only up to the ledger's clock, so the first purge keeps r1 until a write.
    const store = budgetWith({ limits: [{ id: "life", amount: "100", window: "never" }] })
    ok(store.run(record("r1", 30), t0))
    ok(store.run(record("r2", 80), t0))

    store.purge(t0 + day)
    expect(store.rows.size).toBe(0)
    const replay = ok(store.run(record("r2", 80), t0 + 6 * day))
    expect(replay.outcome).toMatchObject({
      type: "record",
      amount: $(80),
      crossed: ["life"],
      replayed: true,
      balance: { remaining: $(-10) },
    })
    expect(replay.entries.map((entry) => entry.type)).toEqual([
      "window.rolled",
      "window.rolled",
      "window.rolled",
    ])
    expect(rejection(store.run(record("r1", 31), t0 + 6 * day)).code).toBe("IDEMPOTENCY_CONFLICT")

    store.purge(t0 + 8 * day)
    expect([...store.receipts.keys()]).toEqual(["r1", "r2"])
    ok(store.run(record("r3", 1, t0 + 8 * day), t0 + 8 * day))
    store.purge(t0 + 8 * day)
    expect([...store.receipts.keys()]).toEqual(["r3"])
    expect(rejection(store.run(record("r1", 30), t0 + 8 * day)).code).toBe("TOO_LATE")
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
        { id: "billing", amount: "1", window: "month", anchor: "2026-10-15T09:30:00+02:00" },
      ],
      onUnavailable: { allowUpTo: "3" },
      closesAt: "2026-12-31T23:59:59Z",
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
      onUnavailable: { allowUpTo: BigInt(300_000_000) },
      closesAt: Date.parse("2026-12-31T23:59:59.000Z"),
    })
    expect(formatBudgetConfig(parsed)).toEqual({
      limits: [
        { id: "m", amount: "12.5", window: "month", enforce: "hard" },
        {
          id: "billing",
          amount: "1",
          window: "month",
          anchor: "2026-10-15T07:30:00.000Z",
          enforce: "hard",
        },
      ],
      holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
      onUnavailable: { allowUpTo: "3" },
      closesAt: "2026-12-31T23:59:59.000Z",
    })
    expect(config(formatBudgetConfig(parsed))).toEqual(parsed)
    expect(config({ limits: [] }).closesAt).toBe(null)
  })

  it("rejects duplicate ids, bad amounts, and inverted TTL bounds", () => {
    const amounts = parseBudgetConfig({
      limits: [
        { id: "a", amount: "1.123456789", window: "day" },
        { id: "b", amount: "99999999999", window: "day" },
      ],
    })
    expect(amounts.err?.rejection).toEqual({
      code: "INVALID_CONFIG",
      issues: [
        "limits.0.amount: invalid amount: not_decimal",
        "limits.1.amount: invalid amount: too_large",
      ],
    })

    expect(
      parseBudgetConfig({
        limits: [
          { id: "a", amount: "1", window: "day" },
          { id: "a", amount: "2", window: "day" },
        ],
        holds: { defaultTtlMs: hour, maxTtlMs: minute },
      }).err?.rejection
    ).toEqual({
      code: "INVALID_CONFIG",
      issues: [
        "limits.1.id: duplicate limit id a",
        "holds.defaultTtlMs: defaultTtlMs must not exceed maxTtlMs",
      ],
    })

    expect(
      parseBudgetConfig({
        limits: [
          { id: "h", amount: "1", window: "hour", anchor: "2026-10-15T00:00:00Z" },
          { id: "d", amount: "1", window: "day", anchor: "2026-10-15" },
        ],
        closesAt: "1969-12-31T23:59:59Z",
      }).err?.rejection
    ).toEqual({
      code: "INVALID_CONFIG",
      issues: [
        "limits.0.anchor: only day, week, and month windows take an anchor",
        "limits.1.anchor: Invalid datetime",
        "closesAt: must not be before 1970",
      ],
    })
  })
})

describe("checkTransition", () => {
  it("catches a settle that does not return the uncovered part of the hold", () => {
    const hold: HoldOperation = {
      kind: "hold",
      id: "h_1",
      idempotencyKey: "k1",
      requestHash: "authorize|8000000000|default",
      amount: $(80),
      createdAt: t0,
      expiresAt: t0 + minute,
      lapsesAt: t0 + 3 * minute,
      state: { status: "open" },
    }
    const before: BudgetState = {
      budget: null,
      ledger: { ...emptyLedger, seq: 2, lastAt: t0, holdSeq: 1, held: $(80) },
      operations: new Map([["h_1", hold]]),
    }
    const broken: Entry = {
      type: "hold.settled",
      holdId: "h_1",
      actual: $(55),
      covered: $(55),
      released: $(0),
      overrun: $(0),
      late: false,
      crossed: [],
      seq: 3,
      at: t0,
    }
    expect(checkTransition(before, [broken], evolve(before, broken))).toEqual([
      "entry 3 covered + released != 8000000000",
      "rows held moved -8000000000, facts say -5500000000",
    ])
  })
})

describe("history does not slow the hot path", () => {
  it("decides in under 1 ms with 50,000 closed operations behind the ledger", () => {
    const view = {
      budget: null as BudgetState["budget"],
      ledger: emptyLedger,
      target: null,
      due: [],
      receipt: null,
      history: [],
    }
    let state = { ...view }
    const first = transition({ view: state, command: upsert(month100), clockMs: t0 })
    if (first.err) throw first.err
    state = { ...state, budget: first.val.next.budget, ledger: first.val.next.ledger }

    for (let i = 0; i < 50_000; i++) {
      const placed = transition({ view: state, command: authorize(`k${i}`, 0), clockMs: t0 + i })
      if (placed.err) throw placed.err
      const hold = placed.val.operations[0] ?? null
      const settled = transition({
        view: { ...state, ledger: placed.val.next.ledger, target: hold },
        command: settle(hold?.id ?? "", 0),
        clockMs: t0 + i,
      })
      if (settled.err) throw settled.err
      state = { ...state, ledger: settled.val.next.ledger }
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
