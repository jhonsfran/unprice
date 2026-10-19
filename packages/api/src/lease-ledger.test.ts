import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { type FrozenReport, type LeaseGrant, LeaseLedger, fromUnits, toUnits } from "./lease-ledger"

const runs = Number.parseInt(process.env.UNPRICE_MODEL_RUNS ?? "300", 10)
const ZERO = BigInt(0)
const LEASE_TTL_MS = 60_000
const DEFAULT_HOLD_TTL_MS = 5_000
const MAX_HOLD_TTL_MS = 20_000
const terms = {
  holds: { defaultTtlMs: DEFAULT_HOLD_TTL_MS, maxTtlMs: MAX_HOLD_TTL_MS },
  closesAt: null,
}

const units = (text: string) => {
  const parsed = toUnits(text)
  if (parsed === null) throw new Error(`bad amount ${text}`)
  return parsed
}

const grant = (fields: Partial<LeaseGrant> = {}): LeaseGrant => ({
  leaseKey: "lease_1",
  seq: 0,
  granted: units("1"),
  captured: ZERO,
  expiresAt: LEASE_TTL_MS,
  asOf: 0,
  terms,
  ...fields,
})

/** The server's answer to `report`: it grants `extended` more and renews the TTL from `at`. */
const answer = (ledger: LeaseLedger, report: FrozenReport, extended: bigint, at: number) =>
  grant({
    seq: report.seq,
    granted: ledger.totals().granted + extended,
    captured: report.captured,
    expiresAt: at + LEASE_TTL_MS,
    asOf: at,
  })

describe("toUnits and fromUnits", () => {
  it("convert decimals at scale 8 exactly", () => {
    expect(toUnits("0.05")).toBe(BigInt(5_000_000))
    expect(toUnits(0.1 + 0.2)).toBe(BigInt(30_000_000))
    expect(toUnits("12")).toBe(BigInt(1_200_000_000))
    expect(fromUnits(BigInt(5_000_000))).toBe("0.05")
    expect(fromUnits(BigInt(1_200_000_000))).toBe("12")
    expect(fromUnits(BigInt(1))).toBe("0.00000001")
    expect(fromUnits(ZERO)).toBe("0")
  })

  it("refuse what the API refuses", () => {
    expect(toUnits("0.123456789")).toBeNull()
    expect(toUnits("-1")).toBeNull()
    expect(toUnits(-1)).toBeNull()
    expect(toUnits("1e3")).toBeNull()
    expect(() => toUnits(Number.NaN)).toThrow("Budget amounts must be finite, received NaN")
  })
})

describe("LeaseLedger holds", () => {
  const authorized = (ledger: LeaseLedger, amount: string, idempotencyKey: string, at = 0) => {
    const decision = ledger.authorize({ amount: units(amount), idempotencyKey }, at)
    if (decision.kind !== "ok") throw new Error(`expected ok, got ${decision.kind}`)
    return decision.value.hold
  }

  it("settles at most the authorized amount and returns the rest", () => {
    const ledger = new LeaseLedger(grant(), 0)
    const hold = authorized(ledger, "0.4", "a")

    expect(ledger.settle(hold.id, units("0.5"), 1)).toEqual({
      kind: "rejected",
      rejection: {
        code: "HOLD_AMOUNT_EXCEEDED",
        holdId: hold.id,
        maximum: units("0.4"),
        actual: units("0.5"),
      },
    })
    expect(ledger.settle(hold.id, units("0.25"), 2)).toEqual({
      kind: "ok",
      value: { actual: units("0.25"), released: units("0.15"), expired: false, replayed: false },
    })
    expect(ledger.settle(hold.id, units("0.25"), 3)).toEqual({
      kind: "ok",
      value: { actual: units("0.25"), released: units("0.15"), expired: false, replayed: true },
    })
    expect(ledger.release(hold.id, 4)).toEqual({
      kind: "rejected",
      rejection: { code: "HOLD_CLOSED", holdId: hold.id, status: "settled" },
    })
    expect(ledger.totals()).toEqual({
      granted: units("1"),
      available: units("0.75"),
      held: ZERO,
      consumed: units("0.25"),
      captured: ZERO,
    })
  })

  it("releases a hold once and replays the release", () => {
    const ledger = new LeaseLedger(grant(), 0)
    const hold = authorized(ledger, "0.4", "a")

    expect(ledger.release(hold.id, 1)).toEqual({
      kind: "ok",
      value: { released: units("0.4"), replayed: false },
    })
    expect(ledger.release(hold.id, 2)).toEqual({
      kind: "ok",
      value: { released: units("0.4"), replayed: true },
    })
    expect(ledger.settle(hold.id, ZERO, 3)).toEqual({
      kind: "rejected",
      rejection: { code: "HOLD_CLOSED", holdId: hold.id, status: "released" },
    })
    expect(ledger.available()).toBe(units("1"))
  })

  it("settles an expired hold at its full amount; only that amount settles afterwards", () => {
    const ledger = new LeaseLedger(grant(), 0)
    const hold = authorized(ledger, "0.4", "a")
    expect(hold.expiresAt).toBe(DEFAULT_HOLD_TTL_MS)

    expect(ledger.release(hold.id, DEFAULT_HOLD_TTL_MS)).toEqual({
      kind: "rejected",
      rejection: { code: "HOLD_CLOSED", holdId: hold.id, status: "expired" },
    })
    expect(ledger.settle(hold.id, units("0.1"), DEFAULT_HOLD_TTL_MS + 1)).toEqual({
      kind: "rejected",
      rejection: { code: "HOLD_CLOSED", holdId: hold.id, status: "expired" },
    })
    expect(ledger.settle(hold.id, units("0.4"), DEFAULT_HOLD_TTL_MS + 2)).toEqual({
      kind: "ok",
      value: { actual: units("0.4"), released: ZERO, expired: true, replayed: true },
    })
    expect(ledger.totals()).toMatchObject({ available: units("0.6"), consumed: units("0.4") })
  })

  it("replays a key with the same request and refuses it with another", () => {
    const ledger = new LeaseLedger(grant(), 0)
    const hold = authorized(ledger, "0.4", "a")

    expect(ledger.authorize({ amount: units("0.4"), idempotencyKey: "a" }, 1)).toEqual({
      kind: "ok",
      value: { hold, replayed: true },
    })
    const conflict = {
      kind: "rejected",
      rejection: { code: "IDEMPOTENCY_CONFLICT", idempotencyKey: "a" },
    }
    expect(ledger.authorize({ amount: units("0.3"), idempotencyKey: "a" }, 2)).toEqual(conflict)
    expect(
      ledger.authorize({ amount: units("0.4"), idempotencyKey: "a", ttlMs: 2_000 }, 3)
    ).toEqual(conflict)
    expect(ledger.charge({ amount: units("0.4"), idempotencyKey: "a" }, 4)).toEqual(conflict)
    expect(ledger.charge({ amount: units("0.1"), idempotencyKey: "c" }, 5)).toEqual({
      kind: "ok",
      value: { amount: units("0.1"), replayed: false },
    })
    expect(ledger.charge({ amount: units("0.1"), idempotencyKey: "c" }, 6)).toEqual({
      kind: "ok",
      value: { amount: units("0.1"), replayed: true },
    })
    expect(ledger.totals()).toMatchObject({ held: units("0.4"), consumed: units("0.1") })
  })

  it("checks the hold TTL, the close time, the deadline, and capacity", () => {
    const closing = new LeaseLedger(grant({ terms: { ...terms, closesAt: 100 } }), 0)

    expect(closing.authorize({ amount: units("2"), idempotencyKey: "big" }, 0)).toEqual({
      kind: "short",
    })
    expect(closing.authorize({ amount: units("0.1"), idempotencyKey: "t", ttlMs: 999 }, 0)).toEqual(
      {
        kind: "rejected",
        rejection: { code: "INVALID_TTL", ttlMs: 999, minTtlMs: 1_000, maxTtlMs: MAX_HOLD_TTL_MS },
      }
    )
    expect(closing.charge({ amount: units("0.1"), idempotencyKey: "late" }, 100)).toEqual({
      kind: "rejected",
      rejection: { code: "BUDGET_CLOSED", closedAt: 100 },
    })
    const open = new LeaseLedger(grant(), 0)
    expect(open.charge({ amount: units("0.1"), idempotencyKey: "stale" }, LEASE_TTL_MS)).toEqual({
      kind: "stale",
    })
  })

  it("resends a frozen report unchanged until it is acknowledged", () => {
    const ledger = new LeaseLedger(grant(), 0)
    ledger.charge({ amount: units("0.2"), idempotencyKey: "c1" }, 1)
    const first = ledger.freeze({ final: false, extend: units("0.5") }, 2)
    ledger.charge({ amount: units("0.3"), idempotencyKey: "c2" }, 3)

    expect(ledger.freeze({ final: false, extend: ZERO }, 4)).toBe(first)
    expect(first).toEqual({ seq: 1, captured: units("0.2"), final: false, extend: units("0.5") })

    ledger.acknowledge(first, answer(ledger, first, units("0.5"), 5), 5)
    expect(ledger.deadline).toBe(5 + LEASE_TTL_MS)
    expect(ledger.freeze({ final: false, extend: ZERO }, 6)).toEqual({
      seq: 2,
      captured: units("0.5"),
      final: false,
      extend: ZERO,
    })
  })

  it("a final report counts open holds in full and ends spending", () => {
    const ledger = new LeaseLedger(grant(), 0)
    const open = authorized(ledger, "0.3", "open")
    const settled = authorized(ledger, "0.2", "settled")
    ledger.settle(settled.id, units("0.05"), 1)

    const final = ledger.freeze({ final: true, extend: ZERO }, 2)

    expect(final).toEqual({ seq: 1, captured: units("0.35"), final: true })
    expect(ledger.phase).toBe("closing")
    expect(ledger.charge({ amount: units("0.01"), idempotencyKey: "after" }, 3)).toEqual({
      kind: "ended",
    })
    expect(ledger.settle(open.id, units("0.1"), 3)).toEqual({
      kind: "rejected",
      rejection: { code: "HOLD_CLOSED", holdId: open.id, status: "expired" },
    })
    ledger.acknowledge(final, answer(ledger, final, ZERO, 4), 4)
    expect(ledger.phase).toBe("ended")
  })
})

type ModelHold = {
  id: string
  amount: bigint
  ttlMs: number | null
  expiresAt: number
  status: "open" | "settled" | "released"
  actual: bigint
  expired: boolean
}

type Command =
  | { type: "authorize"; amount: number; key: number; ttlMs: number | null }
  | { type: "charge"; amount: number; key: number }
  | { type: "settle"; hold: number; percent: number }
  | { type: "release"; hold: number }
  | { type: "advance"; ms: number }
  | { type: "report"; extend: number; room: number; lost: boolean }

const amountArb = fc.integer({ min: 0, max: 400 })
const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    type: fc.constant("authorize" as const),
    amount: amountArb,
    key: fc.integer({ min: 0, max: 15 }),
    ttlMs: fc.constantFrom(null, 999, 2_000, MAX_HOLD_TTL_MS, MAX_HOLD_TTL_MS + 1),
  }),
  fc.record({
    type: fc.constant("charge" as const),
    amount: amountArb,
    key: fc.integer({ min: 0, max: 15 }),
  }),
  fc.record({
    type: fc.constant("settle" as const),
    hold: fc.nat(30),
    percent: fc.integer({ min: 0, max: 120 }),
  }),
  fc.record({ type: fc.constant("release" as const), hold: fc.nat(30) }),
  fc.record({ type: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 8_000 }) }),
  fc.record({
    type: fc.constant("report" as const),
    extend: amountArb,
    room: amountArb,
    lost: fc.boolean(),
  })
)

/** Amounts in the model are whole thousandths, so every step is exact. */
const milli = (n: number) => BigInt(n) * BigInt(100_000)

/**
 * A reference model of one lease: its own hold table, expiry, idempotency, and report sequence.
 * Every step compares the ledger's decision and totals with it.
 */
function runModel(initial: number, commands: readonly Command[]) {
  const ledger = new LeaseLedger(grant({ granted: milli(initial) }), 0)
  const holds: ModelHold[] = []
  const keys = new Map<string, { hold: ModelHold } | { charge: bigint }>()
  let now = 0
  let granted = milli(initial)
  let consumed = ZERO
  let deadline = LEASE_TTL_MS
  let acked = { seq: 0, captured: ZERO }
  let pending: FrozenReport | null = null

  const heldOf = () => holds.reduce((sum, h) => (h.status === "open" ? sum + h.amount : sum), ZERO)
  const expire = () => {
    for (const hold of holds) {
      if (hold.status !== "open" || hold.expiresAt > now) continue
      Object.assign(hold, { status: "settled", actual: hold.amount, expired: true })
      consumed += hold.amount
    }
  }
  const check = () => {
    const totals = ledger.totals()
    expect(totals.granted).toBe(totals.available + totals.held + totals.consumed)
    expect(totals.available >= ZERO).toBe(true)
    expect(totals).toEqual({
      granted,
      available: granted - heldOf() - consumed,
      held: heldOf(),
      consumed,
      captured: acked.captured,
    })
  }
  const admit = (amount: bigint) =>
    now >= deadline ? "stale" : amount > granted - heldOf() - consumed ? "short" : null

  for (const command of commands) {
    switch (command.type) {
      case "advance":
        now += command.ms
        break
      case "authorize": {
        const amount = milli(command.amount)
        const key = `k${command.key}`
        const decision = ledger.authorize(
          { amount, idempotencyKey: key, ttlMs: command.ttlMs ?? undefined },
          now
        )
        expire()
        const known = keys.get(key)
        const ttl = command.ttlMs ?? DEFAULT_HOLD_TTL_MS
        if (known) {
          const replays =
            "hold" in known && known.hold.amount === amount && known.hold.ttlMs === command.ttlMs
          if (replays)
            expect(decision).toMatchObject({
              kind: "ok",
              value: { hold: { id: known.hold.id }, replayed: true },
            })
          else
            expect(decision).toMatchObject({
              kind: "rejected",
              rejection: { code: "IDEMPOTENCY_CONFLICT" },
            })
        } else if (ttl < 1_000 || ttl > MAX_HOLD_TTL_MS) {
          expect(decision).toMatchObject({ kind: "rejected", rejection: { code: "INVALID_TTL" } })
        } else if (admit(amount)) {
          expect(decision).toEqual({ kind: admit(amount) })
        } else {
          if (decision.kind !== "ok") throw new Error(`expected a hold, got ${decision.kind}`)
          const hold: ModelHold = {
            id: decision.value.hold.id,
            amount,
            ttlMs: command.ttlMs,
            expiresAt: now + ttl,
            status: "open",
            actual: ZERO,
            expired: false,
          }
          holds.push(hold)
          keys.set(key, { hold })
        }
        break
      }
      case "charge": {
        const amount = milli(command.amount)
        const key = `k${command.key}`
        const decision = ledger.charge({ amount, idempotencyKey: key }, now)
        expire()
        const known = keys.get(key)
        if (known) {
          const replays = "charge" in known && known.charge === amount
          expect(decision).toEqual(
            replays
              ? { kind: "ok", value: { amount, replayed: true } }
              : {
                  kind: "rejected",
                  rejection: { code: "IDEMPOTENCY_CONFLICT", idempotencyKey: key },
                }
          )
        } else if (admit(amount)) {
          expect(decision).toEqual({ kind: admit(amount) })
        } else {
          expect(decision).toEqual({ kind: "ok", value: { amount, replayed: false } })
          consumed += amount
          keys.set(key, { charge: amount })
        }
        break
      }
      case "settle": {
        const hold = holds[command.hold]
        if (!hold) break
        const actual = (hold.amount * BigInt(command.percent)) / BigInt(100)
        const decision = ledger.settle(hold.id, actual, now)
        expire()
        if (hold.status === "open" && actual > hold.amount) {
          expect(decision).toMatchObject({
            kind: "rejected",
            rejection: { code: "HOLD_AMOUNT_EXCEEDED" },
          })
        } else if (hold.status === "open") {
          expect(decision).toEqual({
            kind: "ok",
            value: { actual, released: hold.amount - actual, expired: false, replayed: false },
          })
          Object.assign(hold, { status: "settled", actual })
          consumed += actual
        } else if (hold.status === "settled" && hold.actual === actual) {
          expect(decision).toMatchObject({
            kind: "ok",
            value: { replayed: true, expired: hold.expired },
          })
        } else {
          expect(decision).toMatchObject({ kind: "rejected", rejection: { code: "HOLD_CLOSED" } })
        }
        break
      }
      case "release": {
        const hold = holds[command.hold]
        if (!hold) break
        const decision = ledger.release(hold.id, now)
        expire()
        if (hold.status === "open") {
          expect(decision).toEqual({
            kind: "ok",
            value: { released: hold.amount, replayed: false },
          })
          hold.status = "released"
        } else if (hold.status === "released") {
          expect(decision).toEqual({ kind: "ok", value: { released: hold.amount, replayed: true } })
        } else {
          expect(decision).toMatchObject({ kind: "rejected", rejection: { code: "HOLD_CLOSED" } })
        }
        break
      }
      case "report": {
        const report = ledger.freeze({ final: false, extend: milli(command.extend) }, now)
        expire()
        if (pending) {
          expect(report).toBe(pending)
        } else {
          expect(report).toEqual({
            seq: acked.seq + 1,
            captured: consumed,
            final: false,
            extend: milli(command.extend),
          })
          expect(report.captured >= acked.captured && report.captured <= granted).toBe(true)
        }
        if (command.lost) {
          pending = report
          break
        }
        const room = milli(command.room)
        const extended =
          report.final || report.extend < room ? (report.final ? ZERO : report.extend) : room
        ledger.acknowledge(report, answer(ledger, report, extended, now), now)
        granted += extended
        acked = { seq: report.seq, captured: report.captured }
        deadline = now + LEASE_TTL_MS
        pending = null
        break
      }
    }
    check()
  }
  return { ledger, now, pending }
}

describe("LeaseLedger properties", () => {
  it("conserves granted = available + held + consumed against a reference model", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000 }),
        fc.array(commandArb, { maxLength: 80 }),
        (initial, commands) => {
          runModel(initial, commands)
        }
      ),
      { numRuns: runs }
    )
  })

  it("a final report captures consumed + held, and the server returns exactly what is available", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000 }),
        fc.array(commandArb, { maxLength: 80 }),
        (initial, commands) => {
          const { ledger, now, pending } = runModel(initial, commands)
          if (pending) ledger.acknowledge(pending, answer(ledger, pending, ZERO, now), now)
          const before = ledger.totals()

          const final = ledger.freeze({ final: true, extend: ZERO }, now)

          expect(final).toEqual({
            seq: final.seq,
            captured: before.consumed + before.held,
            final: true,
          })
          expect(final.captured <= before.granted).toBe(true)
          expect(before.granted - final.captured).toBe(before.available)
          expect(ledger.totals()).toMatchObject({ held: ZERO, consumed: final.captured })
          ledger.acknowledge(final, answer(ledger, final, ZERO, now), now)
          expect(ledger.phase).toBe("ended")
        }
      ),
      { numRuns: runs }
    )
  })
})
