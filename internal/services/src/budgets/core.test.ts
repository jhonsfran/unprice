import { describe, expect, it } from "vitest"
import { formatAmount, parseAmount } from "./amount"
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
} from "./core"
import { MemoryBudgetStore } from "./memory-store.fixture"

const t0 = Date.parse("2026-10-14T10:00:00.000Z")
const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const nov1 = Date.parse("2026-11-01T00:00:00.000Z")
const oct15 = Date.parse("2026-10-15T00:00:00.000Z")

/** Whole units to base units at scale 8. */
const $ = (units: number) => BigInt(units) * BigInt(100_000_000)

const month100: BudgetConfigInput = { limits: [{ id: "month", amount: 100, window: "month" }] }

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

function oneShot(type: "charge" | "record", key: string, amount: bigint): BudgetCommand {
  const cost = { amount }
  return { type, idempotencyKey: key, cost, requestHash: requestFingerprint({ type, cost }) }
}

const charge = (key: string, units: number) => oneShot("charge", key, $(units))
const record = (key: string, units: number) => oneShot("record", key, $(units))
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
        { id: "daily", amount: 50, window: "day" },
        { id: "lifetime", amount: 100, window: "never" },
        { id: "alert", amount: 1, window: "hour", enforce: "soft" },
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
        { id: "month", amount: 100, window: "month" },
        { id: "alert", amount: 50, window: "month", enforce: "soft" },
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

  it("consumes a settle on a purged hold as late usage, once", () => {
    const store = budgetWith(month100)
    ok(store.run(authorize("k1", 80, minute), t0))
    ok(store.run(authorize("k2", 5, minute), t0))
    ok(store.run({ type: "sweep" }, t0 + 3 * minute))
    const purgedAt = t0 + 3 * minute + day
    store.purge(purgedAt)
    expect(store.rows.size).toBe(0)

    const late = ok(store.run(settle("h_1", 25), purgedAt))
    expect(late.outcome).toMatchObject({
      late: true,
      overrun: $(25),
      replayed: false,
      balance: { remaining: $(75) },
    })
    expect(ok(store.run(settle("h_1", 25), purgedAt)).outcome).toMatchObject({
      replayed: true,
      balance: { remaining: $(75) },
    })
    expect(rejection(store.run(settle("h_1", 26), purgedAt)).code).toBe("HOLD_CLOSED")
    expect(rejection(store.run(release("h_1"), purgedAt)).code).toBe("HOLD_CLOSED")

    const gone = ok(store.run(release("h_2"), purgedAt))
    expect([gone.entries.length, gone.outcome]).toMatchObject([
      0,
      { released: $(0), replayed: true },
    ])
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
    const recorded = ok(store.run(record("d", 5), behind))
    expect(recorded.entries[0]?.at).toBe(Date.parse("2026-11-01T00:00:00.001Z"))
    expect(remaining(recorded)).toEqual([["month", $(5)]])
  })

  it("keeps consumption across rename, window change, and remove then re-add", () => {
    const store = budgetWith({ limits: [{ id: "monthly", amount: 100, window: "month" }] })
    ok(store.run(charge("c1", 60), t0))

    const renamed = ok(
      store.run(upsert({ limits: [{ id: "cap", amount: 100, window: "month" }] }), t0)
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
      store.run(upsert({ limits: [{ id: "cap", amount: 100, window: "day" }] }), t0)
    )
    expect(rewindowed.outcome).toMatchObject({
      changes: [{ change: "limit.window", limitId: "cap", from: "month", to: "day" }],
    })
    expect(remaining(rewindowed)).toEqual([["cap", $(40)]])

    ok(store.run(upsert({ limits: [] }), t0))
    const readded = ok(
      store.run(upsert({ limits: [{ id: "cap", amount: 100, window: "month" }] }), t0)
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
    const store = budgetWith({ limits: [{ id: "weekly", amount: 100, window: "week" }] }, sunday)
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
        { id: "month", amount: 100, window: "month" },
        { id: "alerts", amount: 10, window: "day", enforce: "soft" },
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

  it("rejects out-of-range TTLs and amounts", () => {
    const store = budgetWith({ ...month100, holds: { maxTtlMs: hour } })
    expect(rejection(store.run(authorize("k1", 1, 500), t0))).toEqual({
      code: "INVALID_TTL",
      ttlMs: 500,
      minTtlMs: 1_000,
      maxTtlMs: hour,
    })
    expect(rejection(store.run(authorize("k2", 1, hour + 1), t0)).code).toBe("INVALID_TTL")
    expect(rejection(store.run(oneShot("record", "r1", BigInt(-1)), t0))).toEqual({
      code: "INVALID_AMOUNT",
      amount: "-1",
    })
  })
})

describe("config schema", () => {
  it("fills defaults and round-trips through its JSON form", () => {
    const parsed = config({
      limits: [{ id: "m", amount: "12.5", window: "month" }],
      onUnavailable: { allowUpTo: 3 },
    })
    expect(parsed).toEqual({
      limits: [{ id: "m", amount: BigInt(1_250_000_000), window: "month", enforce: "hard" }],
      holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
      onUnavailable: { allowUpTo: BigInt(300_000_000) },
    })
    expect(formatBudgetConfig(parsed)).toEqual({
      limits: [{ id: "m", amount: "12.5", window: "month", enforce: "hard" }],
      holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
      onUnavailable: { allowUpTo: "3" },
    })
    expect(config(formatBudgetConfig(parsed))).toEqual(parsed)
  })

  it("rejects duplicate ids, bad amounts, and inverted TTL bounds", () => {
    const amounts = parseBudgetConfig({
      limits: [
        { id: "a", amount: "1.123456789", window: "day" },
        { id: "b", amount: Number.NaN, window: "day" },
      ],
    })
    expect(amounts.err?.rejection).toEqual({
      code: "INVALID_CONFIG",
      issues: [
        "limits.0.amount: invalid amount: too_precise",
        "limits.1.amount: invalid amount: not_finite",
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
  })
})

describe("parseAmount", () => {
  it.each([
    ["44.95", { ok: true, amount: BigInt(4_495_000_000) }],
    ["0.00000001", { ok: true, amount: BigInt(1) }],
    ["1.100000000", { ok: true, amount: BigInt(110_000_000) }],
    ["92233720368.54775807", { ok: true, amount: BigInt("9223372036854775807") }],
    ["92233720368.54775808", { ok: false, reason: "too_large" }],
    ["1.123456789", { ok: false, reason: "too_precise" }],
    ["1e5", { ok: false, reason: "not_decimal" }],
    [".5", { ok: false, reason: "not_decimal" }],
    ["-1", { ok: false, reason: "negative" }],
    [0.1, { ok: true, amount: BigInt(10_000_000) }],
    [1e-7, { ok: true, amount: BigInt(10) }],
    [0.1 + 0.2, { ok: false, reason: "too_precise" }],
    [2 ** 53 + 2, { ok: false, reason: "unsafe_number" }],
    [Number.NaN, { ok: false, reason: "not_finite" }],
    [-0.5, { ok: false, reason: "negative" }],
  ] as const)("parses %s", (input, expected) => {
    expect(parseAmount(input)).toEqual(expected)
  })

  it("formats canonical decimals", () => {
    expect([BigInt(4_495_000_000), BigInt(-1), BigInt(0)].map(formatAmount)).toEqual([
      "44.95",
      "-0.00000001",
      "0",
    ])
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
