import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  type BudgetBalance,
  type BudgetCommand,
  type BudgetConfig,
  type BudgetOutcome,
  checkTransition,
  emptyLedger,
  evolveLedger,
  requestFingerprint,
} from "./index"
import { MemoryBudgetStore } from "./memory-store.fixture"

const runs = Number.parseInt(process.env.UNPRICE_MODEL_RUNS ?? "300", 10)
const seed = process.env.UNPRICE_MODEL_SEED
  ? Number.parseInt(process.env.UNPRICE_MODEL_SEED, 10)
  : undefined

const start = Date.parse("2026-10-30T22:00:00.000Z")
const second = 1_000
const minute = 60 * second
const hour = 60 * minute
const day = 24 * hour
const ZERO = BigInt(0)

type Window = "hour" | "day" | "week" | "month" | "never"
type ModelLimit = { id: string; amount: bigint; window: Window; enforce: "hard" | "soft" }
type ModelConfig = { limits: ModelLimit[]; defaultTtlMs: number; maxTtlMs: number }

type ModelHold = {
  key: string
  amount: bigint
  expiresAt: number
  lapsesAt: number
  status: "open" | "lapsed" | "settled" | "released"
  changedAt: number
  settle?: Settled
  released?: bigint
}
type Settled = {
  actual: bigint
  covered: bigint
  released: bigint
  overrun: bigint
  late: boolean
  expired: boolean
  crossed: string[]
}
type KeyedRecord = {
  verb: "authorize" | "charge" | "record"
  amount: bigint
  ttlMs: number | undefined
  holdNo: number
  crossed: string[]
  createdAt: number
}

type Expected =
  | { error: string; limitId?: string; remedy?: string }
  | { outcome: Record<string, unknown>; checkBalance: boolean }

/** Calendar math written independently of `windows.ts`: Date.UTC with field overflow. */
function windowRange(window: Window, t: number): { start: number; end: number | null } {
  const d = new Date(t)
  const [y, m, dd, h] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()]
  switch (window) {
    case "hour":
      return { start: Date.UTC(y, m, dd, h), end: Date.UTC(y, m, dd, h + 1) }
    case "day":
      return { start: Date.UTC(y, m, dd), end: Date.UTC(y, m, dd + 1) }
    case "week": {
      const sinceMonday = (d.getUTCDay() + 6) % 7
      return { start: Date.UTC(y, m, dd - sinceMonday), end: Date.UTC(y, m, dd - sinceMonday + 7) }
    }
    case "month":
      return { start: Date.UTC(y, m, 1), end: Date.UTC(y, m + 1, 1) }
    case "never":
      return { start: Number.NEGATIVE_INFINITY, end: null }
  }
}

/**
 * Reference budget: keeps raw history (every consumption, every hold) and recomputes balances
 * from it, with rules restated from ADR-0006 rather than taken from the core.
 */
class ReferenceBudget {
  config: ModelConfig | null = null
  unit = "money:USD"
  version = 0
  lastWriteAt = 0
  holdCount = 0
  readonly consumptions: Array<{ at: number; amount: bigint }> = []
  readonly holds = new Map<number, ModelHold>()
  readonly keyed = new Map<string, KeyedRecord>()

  purge(clock: number) {
    const retention = 24 * hour
    for (const [n, hold] of this.holds) {
      if (hold.status !== "open" && clock >= hold.changedAt + retention) {
        this.holds.delete(n)
        this.keyed.delete(hold.key)
      }
    }
    for (const [key, rec] of this.keyed) {
      if (rec.verb !== "authorize" && clock >= rec.createdAt + retention) this.keyed.delete(key)
    }
  }

  balance(now: number) {
    const config = this.config
    if (!config) throw new Error("no config")
    let held = ZERO
    for (const hold of this.holds.values()) {
      if (hold.status === "open" && hold.lapsesAt > now) held += hold.amount
    }
    const limits = config.limits.map((limit) => {
      const range = windowRange(limit.window, now)
      let consumed = ZERO
      for (const c of this.consumptions) if (c.at >= range.start) consumed += c.amount
      return {
        ...limit,
        consumed,
        held,
        remaining: limit.amount - consumed - held,
        resetsAt: range.end,
      }
    })
    const hard = limits.filter((l) => l.enforce === "hard").map((l) => l.remaining)
    const remaining = hard.length ? hard.reduce((a, b) => (b < a ? b : a)) : null
    return { held, limits, remaining }
  }

  crossed(now: number, delta: bigint): string[] {
    return this.balance(now)
      .limits.filter((l) => l.remaining >= ZERO && l.remaining + delta < ZERO)
      .map((l) => l.id)
  }

  block(now: number, amount: bigint): { limitId: string; remedy: string } | null {
    const failing = this.balance(now).limits.filter(
      (l) => l.enforce === "hard" && l.remaining - amount < ZERO
    )
    if (failing.length === 0) return null
    let pick = failing[0]!
    for (const l of failing.slice(1)) {
      if (pick.resetsAt !== null && (l.resetsAt === null || l.resetsAt > pick.resetsAt)) pick = l
    }
    let remedy = "raise_limit"
    if (amount <= pick.amount) {
      if (pick.held > ZERO && pick.remaining + pick.held - amount >= ZERO) remedy = "release_holds"
      else if (pick.window !== "never") remedy = "wait_for_reset"
    }
    return { limitId: pick.id, remedy }
  }

  apply(command: BudgetCommand, clock: number): Expected {
    const now = Math.max(clock, this.lastWriteAt)
    const due = [...this.holds.values()].filter((h) => h.status === "open" && h.lapsesAt <= now)
    const decided = this.decide(command, now, due.length)
    if ("error" in decided) return decided
    for (const hold of due) {
      // Only an accepted command persists the lapse.
      if (hold.status === "open") Object.assign(hold, { status: "lapsed", changedAt: now })
    }
    if (decided.wrote || due.length > 0) this.lastWriteAt = now
    return { outcome: decided.outcome, checkBalance: decided.checkBalance }
  }

  private decide(
    command: BudgetCommand,
    now: number,
    lapsing: number
  ):
    | { error: string; limitId?: string; remedy?: string }
    | { outcome: Record<string, unknown>; wrote: boolean; checkBalance: boolean } {
    const isLapsed = (h: ModelHold) =>
      h.status === "lapsed" || (h.status === "open" && h.lapsesAt <= now)

    if (command.type === "upsert") {
      const next: ModelConfig = {
        limits: command.config.limits.map((l) => ({ ...l })),
        defaultTtlMs: command.config.holds.defaultTtlMs,
        maxTtlMs: command.config.holds.maxTtlMs,
      }
      if (this.config && command.unit !== this.unit) return { error: "UNIT_IMMUTABLE" }
      const same = this.config && stringify(this.config) === stringify(next)
      if (!same) {
        this.unit = command.unit
        this.config = next
        this.version += 1
      }
      return { outcome: { version: this.version }, wrote: !same, checkBalance: true }
    }
    if (command.type === "sweep")
      return { outcome: { lapsed: lapsing }, wrote: false, checkBalance: false }
    const config = this.config
    if (!config) return { error: "BUDGET_NOT_FOUND" }
    if (command.type === "get") return { outcome: {}, wrote: false, checkBalance: true }

    if (command.type === "settle" || command.type === "release") {
      const match = /^h_([1-9]\d*)$/.exec(command.holdId)
      const n = match ? Number(match[1]) : 0
      const hold = this.holds.get(n)
      const minted = n >= 1 && n <= this.holdCount
      // A purged hold's outcome is unknown, so it is retired rather than settled twice.
      if (!hold) return { error: minted ? "HOLD_RETIRED" : "HOLD_NOT_FOUND" }

      if (command.type === "release") {
        if (hold.status === "settled") return { error: "HOLD_CLOSED" }
        if (hold.status === "released") {
          return {
            outcome: { released: hold.released, replayed: true },
            wrote: false,
            checkBalance: true,
          }
        }
        const released = isLapsed(hold) ? ZERO : hold.amount
        Object.assign(hold, { status: "released", changedAt: now, released })
        return { outcome: { released, replayed: false }, wrote: true, checkBalance: true }
      }

      const actual = command.cost.amount
      if (hold.status === "settled" && hold.settle) {
        return hold.settle.actual === actual
          ? { outcome: { ...hold.settle, replayed: true }, wrote: false, checkBalance: true }
          : { error: "HOLD_CLOSED" }
      }
      if (hold.status === "released") return { error: "HOLD_CLOSED" }

      const open = !isLapsed(hold)
      const covered = open ? (actual < hold.amount ? actual : hold.amount) : ZERO
      const released = open ? hold.amount - covered : ZERO
      const settled: Settled = {
        actual,
        covered,
        released,
        overrun: actual - covered,
        late: !open,
        expired: !open || now >= hold.expiresAt,
        crossed: this.crossed(now, covered + released - actual),
      }
      this.consumptions.push({ at: now, amount: actual })
      Object.assign(hold, { status: "settled", changedAt: now, settle: settled })
      return { outcome: { ...settled, replayed: false }, wrote: true, checkBalance: true }
    }

    const amount = command.cost.amount
    const ttlMs = command.type === "authorize" ? command.ttlMs : undefined
    const prior = this.keyed.get(command.idempotencyKey)
    if (prior) {
      if (prior.verb !== command.type || prior.amount !== amount || prior.ttlMs !== ttlMs) {
        return { error: "IDEMPOTENCY_CONFLICT" }
      }
      const outcome =
        prior.verb === "authorize"
          ? {
              holdId: `h_${prior.holdNo}`,
              expiresAt: this.holds.get(prior.holdNo)?.expiresAt,
              replayed: true,
            }
          : { crossed: prior.crossed, replayed: true }
      return { outcome, wrote: false, checkBalance: true }
    }

    const effectiveTtl = ttlMs ?? config.defaultTtlMs
    if (command.type === "authorize" && (effectiveTtl < 1_000 || effectiveTtl > config.maxTtlMs)) {
      return { error: "INVALID_TTL" }
    }
    if (command.type !== "record") {
      const blocked = this.block(now, amount)
      if (blocked) return { error: "LIMIT_EXCEEDED", ...blocked }
    }
    const crossed = this.crossed(now, -amount)
    const rec: KeyedRecord = {
      verb: command.type,
      amount,
      ttlMs,
      holdNo: 0,
      crossed,
      createdAt: now,
    }
    this.keyed.set(command.idempotencyKey, rec)

    if (command.type !== "authorize") {
      this.consumptions.push({ at: now, amount })
      return { outcome: { crossed, replayed: false }, wrote: true, checkBalance: true }
    }
    this.holdCount += 1
    rec.holdNo = this.holdCount
    const expiresAt = now + effectiveTtl
    this.holds.set(this.holdCount, {
      key: command.idempotencyKey,
      amount,
      expiresAt,
      lapsesAt: expiresAt + 2 * effectiveTtl,
      status: "open",
      changedAt: now,
    })
    return {
      outcome: { holdId: `h_${this.holdCount}`, expiresAt, replayed: false },
      wrote: true,
      checkBalance: true,
    }
  }
}

function stringify(value: unknown) {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v))
}

const windowArb = fc.constantFrom<Window>("hour", "day", "week", "month", "never")
const scaleArb = fc.constantFrom(BigInt(1), BigInt(100_000_000), BigInt("10000000000000000"))

function configArb(scale: bigint): fc.Arbitrary<BudgetConfig> {
  const limit = fc.record({
    id: fc.constantFrom("a", "b", "c", "d"),
    amount: fc.integer({ min: 0, max: 900 }).map((k) => BigInt(k) * scale),
    window: windowArb,
    enforce: fc.constantFrom<"hard" | "soft">("hard", "hard", "soft"),
  })
  return fc
    .record({
      limits: fc.uniqueArray(limit, { minLength: 1, maxLength: 3, selector: (l) => l.id }),
      ttl: fc.constantFrom([minute, hour], [15 * minute, day], [hour, hour]),
    })
    .map(({ limits, ttl }) => ({
      limits,
      holds: { defaultTtlMs: ttl[0] ?? minute, maxTtlMs: ttl[1] ?? hour },
      onUnavailable: "deny" as const,
    }))
}

/** Settle and release name a hold by its distance from the newest one; -1 was never minted. */
type Planned =
  | BudgetCommand
  | { type: "settle-ref"; offset: number; amount: bigint }
  | { type: "release-ref"; offset: number }
  | { type: "retry" }

function commandArb(scale: bigint): fc.Arbitrary<Planned> {
  const amount = fc
    .oneof(fc.constantFrom(0, 1, 5, 20, 50, 120, 400), fc.integer({ min: 0, max: 400 }))
    .map((k) => BigInt(k) * scale)
  const key = fc.constantFrom("k0", "k1", "k2", "k3", "k4", "k5")
  const offset = fc.constantFrom(0, 0, 0, 1, 1, 2, 4, -1)
  const ttlMs = fc.constantFrom(
    undefined,
    undefined,
    undefined,
    second,
    minute,
    15 * minute,
    2 * hour,
    500
  )
  const keyed = (type: "charge" | "record") =>
    fc.record({ idempotencyKey: key, amount }).map(({ idempotencyKey, amount }): Planned => {
      const cost = { amount }
      return { type, idempotencyKey, cost, requestHash: requestFingerprint({ type, cost }) }
    })
  const authorize = fc
    .record({ idempotencyKey: key, amount, ttlMs })
    .map(({ idempotencyKey, amount, ttlMs }): Planned => {
      const cost = { amount }
      return {
        type: "authorize",
        idempotencyKey,
        cost,
        ttlMs,
        requestHash: requestFingerprint({ type: "authorize", cost, ttlMs }),
      }
    })
  const upsert = fc
    .record({
      config: configArb(scale),
      unit: fc.constantFrom("money:USD", "money:USD", "money:EUR"),
    })
    .map(
      ({ config, unit }): Planned => ({
        type: "upsert",
        key: "customer:acme",
        projectId: "proj_1",
        unit,
        config,
      })
    )
  return fc.oneof(
    { weight: 5, arbitrary: authorize },
    {
      weight: 4,
      arbitrary: fc
        .record({ offset, amount })
        .map(({ offset, amount }): Planned => ({ type: "settle-ref", offset, amount })),
    },
    { weight: 2, arbitrary: offset.map((offset): Planned => ({ type: "release-ref", offset })) },
    {
      weight: 1,
      arbitrary: fc.constantFrom<Planned>(
        { type: "settle", holdId: "hold_1", cost: { amount: scale } },
        { type: "release", holdId: "h_0" }
      ),
    },
    { weight: 3, arbitrary: keyed("charge") },
    { weight: 3, arbitrary: keyed("record") },
    { weight: 3, arbitrary: fc.constant<Planned>({ type: "retry" }) },
    { weight: 1, arbitrary: upsert },
    { weight: 1, arbitrary: fc.constantFrom<Planned>({ type: "get" }, { type: "sweep" }) }
  )
}

function resolve(planned: Planned, previous: BudgetCommand, holdCount: number): BudgetCommand {
  const holdId = (offset: number) => `h_${Math.max(0, holdCount - offset)}`
  switch (planned.type) {
    case "retry":
      return previous
    case "settle-ref":
      return { type: "settle", holdId: holdId(planned.offset), cost: { amount: planned.amount } }
    case "release-ref":
      return { type: "release", holdId: holdId(planned.offset) }
    default:
      return planned
  }
}

const advanceArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(0, second, minute, 10 * minute) },
  { weight: 2, arbitrary: fc.constantFrom(hour, 6 * hour, day) },
  { weight: 1, arbitrary: fc.constantFrom(3 * day, 8 * day, 32 * day) },
  { weight: 1, arbitrary: fc.constantFrom(-minute, -2 * hour, -3 * day) }
)

const scenarioArb = scaleArb.chain((scale) =>
  fc.record({
    config: configArb(scale),
    steps: fc.array(fc.record({ advanceMs: advanceArb, planned: commandArb(scale) }), {
      minLength: 15,
      maxLength: 80,
    }),
  })
)

function balanceView(balance: BudgetBalance) {
  return {
    remaining: balance.remaining,
    held: balance.held,
    limits: balance.limits.map((l) => [l.id, l.remaining, l.resetsAt]),
  }
}

function outcomeFields(outcome: BudgetOutcome, expected: Record<string, unknown>) {
  const picked: Record<string, unknown> = {}
  const source = outcome.type === "upsert" ? { version: outcome.budget.version } : outcome
  for (const key of Object.keys(expected)) picked[key] = (source as Record<string, unknown>)[key]
  return picked
}

describe("budget core against a reference model", () => {
  it("agrees on every outcome, balance, and journal fold for any command sequence", () => {
    fc.assert(
      fc.property(scenarioArb, ({ config, steps }) => {
        const store = new MemoryBudgetStore()
        const model = new ReferenceBudget()
        let clock = start
        let command: BudgetCommand = {
          type: "upsert",
          key: "customer:acme",
          projectId: "proj_1",
          unit: "money:USD",
          config,
        }
        const all: Array<{ advanceMs: number; planned: Planned }> = [
          { advanceMs: 0, planned: command },
          ...steps,
        ]

        for (const step of all) {
          clock += step.advanceMs
          command = resolve(step.planned, command, model.holdCount)
          store.purge(clock)
          model.purge(clock)
          const expected = model.apply(command, clock)
          const result = store.run(command, clock)

          if ("error" in expected) {
            const rejection = result.err?.rejection
            const blocked = rejection?.code === "LIMIT_EXCEEDED" ? rejection.blocked : undefined
            expect({
              code: rejection?.code,
              limitId: blocked?.limitId,
              remedy: blocked?.remedy,
            }).toEqual({
              code: expected.error,
              limitId: expected.limitId,
              remedy: expected.remedy,
            })
            continue
          }
          if (result.err) throw result.err

          const { outcome, entries, next } = result.val
          expect(outcomeFields(outcome, expected.outcome)).toEqual(expected.outcome)
          if (expected.checkBalance) {
            const balance =
              "balance" in outcome
                ? outcome.balance
                : "budget" in outcome
                  ? outcome.budget.balance
                  : null
            const reference = model.balance(Math.max(clock, model.lastWriteAt))
            expect(balance && balanceView(balance)).toEqual({
              remaining: reference.remaining,
              held: reference.held,
              limits: reference.limits.map((l) => [l.id, l.remaining, l.resetsAt]),
            })
          }
          expect(checkTransition(store.lastBefore!, entries, next)).toEqual([])
          expect(store.entries.reduce(evolveLedger, emptyLedger)).toEqual(store.ledger)
        }
      }),
      { numRuns: runs, seed }
    )
  })
})
