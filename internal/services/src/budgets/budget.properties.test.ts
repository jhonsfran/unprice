import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  type BudgetBalance,
  type BudgetCommand,
  type BudgetConfig,
  type BudgetOutcome,
  type Ledger,
  RECORD_ACCEPT_WINDOW_MS,
  RECORD_DEDUPE_MS,
  RECORD_FUTURE_SKEW_MS,
  anchoredWindowBounds,
  countersOf,
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
type Every = "day" | "week" | "month"
type ModelLimit = {
  id: string
  amount: bigint
  window: Window
  anchor?: number
  enforce: "hard" | "soft"
}
type ModelConfig = {
  limits: ModelLimit[]
  defaultTtlMs: number
  maxTtlMs: number
  closesAt: number | null
}
type Range = { start: number; end: number | null }
type Period = [windowId: string, start: number, end: number, consumed: bigint]

type ModelHold = {
  key: string
  amount: bigint
  expiresAt: number
  status: "open" | "settled" | "released"
  changedAt: number
  settle?: Settled
  released?: bigint
}
type Settled = {
  actual: bigint
  released: bigint
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
/**
 * A window id counts the consumptions from index `from` on that happen before `until`, which is
 * set when no limit uses it any more.
 */
type Segment = { id: string; window: Window; anchor?: number; from: number; until: number | null }

type Expected =
  | { error: string; limitId?: string; remedy?: string }
  | { outcome: Record<string, unknown>; checkBalance: boolean }

/** Calendar math written independently of `windows.ts`: Date.UTC with field overflow. */
function windowRange(window: Window, t: number): Range {
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
 * Anchored periods from calendar fields: the anchor's time of day on the right date, stepping back
 * one period when that lands after `t`. Months clamp the anchor's day to the month's last day.
 */
function anchoredRange(every: Every, anchor: number, t: number): { start: number; end: number } {
  const a = new Date(anchor)
  const at = (y: number, m: number, d: number) =>
    Date.UTC(y, m, d, a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds(), a.getUTCMilliseconds())
  const d = new Date(t)
  const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]
  if (every === "month") {
    const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate()
    const monthStart = (mm: number) => at(y, mm, Math.min(a.getUTCDate(), lastDay(y, mm)))
    const mm = monthStart(m) <= t ? m : m - 1
    return { start: monthStart(mm), end: monthStart(mm + 1) }
  }
  const length = every === "day" ? 1 : 7
  const back = every === "day" ? 0 : (d.getUTCDay() - a.getUTCDay() + 7) % 7
  const first = at(y, m, dd - back) <= t ? dd - back : dd - back - length
  return { start: at(y, m, first), end: at(y, m, first + length) }
}

function rangeOf(window: Window, anchor: number | undefined, t: number): Range {
  return anchor === undefined ? windowRange(window, t) : anchoredRange(window as Every, anchor, t)
}

function idOf(limit: { window: Window; anchor?: number }): string {
  if (limit.anchor === undefined) return limit.window
  const date = new Date(limit.anchor)
  const dd =
    limit.window === "month"
      ? date.getUTCDate()
      : limit.window === "week"
        ? 1 + ((date.getUTCDay() + 3) % 7)
        : 1
  const anchor = Date.UTC(
    1970,
    0,
    dd,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  )
  return `${limit.window}@${new Date(anchor).toISOString()}`
}

/**
 * Reference budget: keeps raw history (every consumption, every hold, which window ids counted
 * when) and recomputes balances and window history from it, with rules restated from ADR-0006
 * rather than taken from the core.
 */
class ReferenceBudget {
  config: ModelConfig | null = null
  unit = "money:USD"
  version = 0
  lastWriteAt = 0
  holdCount = 0
  rolledCount = 0
  readonly consumptions: Array<{ at: number; amount: bigint }> = []
  readonly holds = new Map<number, ModelHold>()
  readonly keyed = new Map<string, KeyedRecord>()
  /** Every config in force, with when it took effect: a period reports under the one at its end. */
  readonly configs: Array<{ at: number; ids: Set<string> }> = []
  readonly segments: Segment[] = (["hour", "day", "week", "month", "never"] as const).map(
    (window) => ({ id: window, window, from: 0, until: null })
  )

  /**
   * A closed row answers until its retention ends at the command's clock: a hold or a charge for a
   * day after it closed, a record for 8 days. Only the alarm deletes rows.
   */
  private holdLive(hold: ModelHold, now: number) {
    return hold.status === "open" || now < hold.changedAt + day
  }

  private keyedLive(rec: KeyedRecord, now: number) {
    if (rec.verb === "authorize") {
      const hold = this.holds.get(rec.holdNo)
      return hold !== undefined && this.holdLive(hold, now)
    }
    return now < rec.createdAt + (rec.verb === "record" ? 8 * day : day)
  }

  alarm(clock: number) {
    if (!this.config) return
    const now = Math.max(clock, this.lastWriteAt)
    this.lastWriteAt = now
    this.rolledCount = this.rolledPeriods(now).length
    for (const [key, rec] of this.keyed) if (!this.keyedLive(rec, now)) this.keyed.delete(key)
    for (const [n, hold] of this.holds) if (!this.holdLive(hold, now)) this.holds.delete(n)
  }

  /** The segment of `id` still counting at `t`, if any. */
  segmentAt(id: string, t: number): Segment | undefined {
    return this.segments.find((s) => s.id === id && (s.until === null || t < s.until))
  }

  private countedBy(segment: Segment) {
    return this.consumptions.filter(
      (c, i) => i >= segment.from && (segment.until === null || c.at < segment.until)
    )
  }

  /** Consumption the segment counted in `range`. */
  counted(segment: Segment, range: Range): bigint {
    let sum = ZERO
    for (const c of this.countedBy(segment)) {
      if (c.at >= range.start && (range.end === null || c.at < range.end)) sum += c.amount
    }
    return sum
  }

  /** Whether a limit used the window id when a period of it ended. */
  private limitedAt(id: string, end: number) {
    let ids: Set<string> | undefined
    for (const config of this.configs) if (config.at < end) ids = config.ids
    return ids?.has(id) ?? false
  }

  /** Every period that ended by `now` with consumption in it on a window limited at its end. */
  rolledPeriods(now: number): Period[] {
    const periods = new Map<string, Period>()
    for (const segment of this.segments) {
      if (segment.anchor !== undefined && this.segmentAt(segment.id, now) !== segment) continue
      for (const c of this.countedBy(segment)) {
        const range = rangeOf(segment.window, segment.anchor, c.at)
        if (range.end === null || range.end > now) continue
        if (!this.limitedAt(segment.id, range.end)) continue
        const key = `${segment.id}|${range.start}`
        const prior = periods.get(key)?.[3] ?? ZERO
        periods.set(key, [segment.id, range.start, range.end, prior + c.amount])
      }
    }
    return sortPeriods([...periods.values()].filter((period) => period[3] > ZERO))
  }

  /** Follows a config change: new anchors count from `now`, dropped ones until their period ends. */
  track(config: ModelConfig, now: number) {
    const live = (s: Segment) => s.until === null || now < s.until
    const used = new Map(
      config.limits.filter((l) => l.anchor !== undefined).map((l) => [idOf(l), l] as const)
    )
    for (const segment of this.segments) {
      if (segment.anchor === undefined || !live(segment)) continue
      segment.until = used.has(segment.id)
        ? null
        : (segment.until ?? rangeOf(segment.window, segment.anchor, now).end)
    }
    for (const [id, limit] of used) {
      if (this.segments.some((s) => s.id === id && live(s))) continue
      const from = this.consumptions.length
      this.segments.push({ id, window: limit.window, anchor: limit.anchor, from, until: null })
    }
  }

  balance(now: number) {
    const config = this.config
    if (!config) throw new Error("no config")
    let held = ZERO
    for (const hold of this.holds.values()) {
      if (hold.status === "open") held += hold.amount
    }
    const limits = config.limits.map((limit) => {
      const range = rangeOf(limit.window, limit.anchor, now)
      const segment = this.segmentAt(idOf(limit), now)
      const consumed = segment ? this.counted(segment, range) : ZERO
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

  crossed(now: number, amount: bigint): string[] {
    return this.balance(now)
      .limits.filter(
        (l) => l.enforce === "soft" && l.consumed <= l.amount && l.consumed + amount > l.amount
      )
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
    if (failing.every((l) => l.consumed + amount <= l.amount)) remedy = "release_holds"
    else if (failing.every((l) => l.resetsAt !== null && l.held + amount <= l.amount))
      remedy = "wait_for_reset"
    if (remedy === "raise_limit") pick = failing.find((limit) => amount > limit.amount) ?? pick
    return { limitId: pick.id, remedy }
  }

  apply(command: BudgetCommand, clock: number): Expected {
    const now = Math.max(clock, this.lastWriteAt)
    const decided = this.decide(command, now)
    if ("error" in decided) return decided
    // An accepted command also persists the roll of every reported period that ended, and a sweep
    // always moves the clock.
    const rolled = this.rolledPeriods(now).length
    const sweep = command.type === "sweep" && this.config !== null
    const retired = this.segments.some(
      (segment) =>
        segment.until !== null && segment.until > this.lastWriteAt && segment.until <= now
    )
    if (decided.wrote || rolled > this.rolledCount || sweep || retired) {
      this.lastWriteAt = now
    }
    this.rolledCount = rolled
    return { outcome: decided.outcome, checkBalance: decided.checkBalance }
  }

  private decide(
    command: BudgetCommand,
    now: number
  ):
    | { error: string; limitId?: string; remedy?: string }
    | { outcome: Record<string, unknown>; wrote: boolean; checkBalance: boolean } {
    if (command.type === "upsert") {
      const next: ModelConfig = {
        limits: command.config.limits.map((l) => ({ ...l })),
        defaultTtlMs: command.config.holds.defaultTtlMs,
        maxTtlMs: command.config.holds.maxTtlMs,
        closesAt: command.config.closesAt,
      }
      if (this.config && command.unit !== this.unit) return { error: "UNIT_IMMUTABLE" }
      const windowOf = new Map(this.config?.limits.map((l) => [l.id, idOf(l)]))
      if (next.limits.some((l) => (windowOf.get(l.id) ?? idOf(l)) !== idOf(l))) {
        return { error: "LIMIT_WINDOW_IMMUTABLE" }
      }
      const configIdentity = (value: ModelConfig) => ({
        ...value,
        limits: value.limits.map((limit) => ({
          ...limit,
          anchor: limit.anchor === undefined ? undefined : idOf(limit),
        })),
      })
      const same =
        this.config && stringify(configIdentity(this.config)) === stringify(configIdentity(next))
      const retained = new Set(
        this.segments
          .filter(
            (segment) =>
              segment.anchor !== undefined && (segment.until === null || segment.until > now)
          )
          .map((segment) => segment.id)
      )
      const added = new Set(
        next.limits
          .filter((limit) => limit.anchor !== undefined && !retained.has(idOf(limit)))
          .map(idOf)
      )
      if (added.size > 0 && retained.size + added.size > 32)
        return { error: "WINDOW_CAPACITY_EXCEEDED" }
      if (!same && this.config) {
        const held = [...this.holds.values()].reduce(
          (sum, hold) => sum + (hold.status === "open" ? hold.amount : ZERO),
          ZERO
        )
        for (const limit of next.limits) {
          const segment = this.segmentAt(idOf(limit), now)
          const consumed = segment
            ? this.counted(segment, rangeOf(limit.window, limit.anchor, now))
            : ZERO
          if (limit.enforce === "hard" && limit.amount < consumed + held) {
            return { error: "LIMIT_BELOW_USAGE" }
          }
        }
      }
      if (!same) {
        this.unit = command.unit
        this.config = next
        this.version += 1
        this.track(next, now)
        this.configs.push({ at: now, ids: new Set(next.limits.map(idOf)) })
      }
      const closed = next.closesAt !== null && now >= next.closesAt
      return { outcome: { version: this.version, closed }, wrote: !same, checkBalance: true }
    }
    if (command.type === "sweep") return { outcome: {}, wrote: false, checkBalance: false }
    const config = this.config
    if (!config) return { error: "BUDGET_NOT_FOUND" }
    if (command.type === "get") {
      const closed = config.closesAt !== null && now >= config.closesAt
      return { outcome: { closed }, wrote: false, checkBalance: true }
    }

    if (command.type === "settle" || command.type === "release") {
      const match = /^h_([1-9]\d*)$/.exec(command.holdId)
      const n = match ? Number(match[1]) : 0
      const stored = this.holds.get(n)
      const hold = stored && this.holdLive(stored, now) ? stored : undefined
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
        const released = hold.amount
        Object.assign(hold, { status: "released", changedAt: now, released })
        return { outcome: { released, replayed: false }, wrote: true, checkBalance: true }
      }

      const actual = command.amount
      if (hold.status === "settled" && hold.settle) {
        return hold.settle.actual === actual
          ? { outcome: { ...hold.settle, replayed: true }, wrote: false, checkBalance: true }
          : { error: "HOLD_CLOSED" }
      }
      if (hold.status === "released") return { error: "HOLD_CLOSED" }
      if (actual > hold.amount) return { error: "HOLD_AMOUNT_EXCEEDED" }

      const settled: Settled = {
        actual,
        released: hold.amount - actual,
        expired: now >= hold.expiresAt,
        crossed: this.crossed(now, actual),
      }
      this.consumptions.push({ at: now, amount: actual })
      Object.assign(hold, { status: "settled", changedAt: now, settle: settled })
      return { outcome: { ...settled, replayed: false }, wrote: true, checkBalance: true }
    }

    const amount = command.amount
    const ttlMs = command.type === "authorize" ? command.ttlMs : undefined
    const occurredAt = command.type === "record" ? command.occurredAt : undefined
    const stored = this.keyed.get(command.idempotencyKey)
    const prior = stored && this.keyedLive(stored, now) ? stored : undefined
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
          : { amount: prior.amount, crossed: prior.crossed, replayed: true }
      return { outcome, wrote: false, checkBalance: true }
    }

    const effectiveTtl = ttlMs ?? config.defaultTtlMs
    if (command.type === "authorize" && (effectiveTtl < 1_000 || effectiveTtl > config.maxTtlMs)) {
      return { error: "INVALID_TTL" }
    }
    if (occurredAt !== undefined && occurredAt > now + 5 * minute) {
      return { error: "INVALID_OCCURRED_AT" }
    }
    if (occurredAt !== undefined && occurredAt < now - 7 * day) return { error: "TOO_LATE" }
    const grace = command.type === "record" ? day : 0
    if (config.closesAt !== null && now >= config.closesAt + grace) {
      return { error: "BUDGET_CLOSED" }
    }
    const blocked = this.block(now, amount)
    if (blocked) return { error: "LIMIT_EXCEEDED", ...blocked }
    const crossed = this.crossed(now, amount)
    const rec: KeyedRecord = {
      verb: command.type,
      amount,
      ttlMs,
      holdNo: 0,
      crossed,
      createdAt: now,
    }
    // A row past its retention is replaced, and so is the hold it named.
    if (stored?.verb === "authorize") this.holds.delete(stored.holdNo)
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

function sortPeriods(periods: Period[]): Period[] {
  return periods.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])
}

const windowArb = fc.constantFrom<Window>("hour", "day", "week", "month", "never")
const scaleArb = fc.constantFrom(BigInt(1), BigInt(100_000_000), BigInt("10000000000000000"))
/** Month-end, leap-day, and future anchors, few enough that limits re-add the same ones. */
const anchorArb = fc.constantFrom(
  Date.parse("2026-01-31T10:00:00.000Z"),
  Date.parse("2024-02-29T00:00:00.000Z"),
  Date.parse("2026-10-29T06:30:00.000Z"),
  Date.parse("2026-11-30T23:00:00.000Z"),
  Date.parse("2027-03-31T12:00:00.000Z")
)

function configArb(scale: bigint): fc.Arbitrary<BudgetConfig> {
  // Half the ids name their window id, so most upserts pass the fixed-window rule and keep
  // re-adding the same anchors; the shared names exercise renames and LIMIT_WINDOW_IMMUTABLE.
  const limit = fc
    .record({
      name: fc.constantFrom("a", "b", "c", "d", null, null, null, null),
      amount: fc.integer({ min: 0, max: 900 }).map((k) => BigInt(k) * scale),
      window: windowArb,
      anchor: fc.option(anchorArb, { freq: 2, nil: undefined }),
      enforce: fc.constantFrom<"hard" | "soft">("hard", "hard", "soft"),
    })
    .map(({ name, anchor, ...rest }) => {
      const limit =
        anchor === undefined || rest.window === "hour" || rest.window === "never"
          ? rest
          : { ...rest, anchor }
      return { id: name ?? idOf(limit), ...limit }
    })
  return fc
    .record({
      limits: fc.uniqueArray(limit, { minLength: 1, maxLength: 3, selector: (l) => l.id }),
      ttl: fc.constantFrom([minute, hour], [15 * minute, day], [hour, hour]),
      closesAt: fc.oneof(
        { weight: 4, arbitrary: fc.constant(null) },
        {
          weight: 1,
          arbitrary: fc.constantFrom(
            start - day,
            start + 2 * hour,
            start + 2 * day,
            start + 9 * day
          ),
        }
      ),
    })
    .map(({ limits, ttl, closesAt }) => ({
      limits,
      holds: { defaultTtlMs: ttl[0] ?? minute, maxTtlMs: ttl[1] ?? hour },
      onUnavailable: "deny" as const,
      closesAt,
    }))
}

/**
 * Settle and release name a hold by its distance from the newest one; -1 was never minted. A
 * record names its `occurredAt` relative to the clock; `retry-record` resends the last record.
 */
type Planned =
  | BudgetCommand
  | { type: "settle-ref"; offset: number; amount: bigint }
  | { type: "release-ref"; offset: number }
  | { type: "record-ref"; idempotencyKey: string; amount: bigint; occurredOffset: number }
  | { type: "retry" }
  | { type: "retry-record" }

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
  const occurredOffset = fc.constantFrom(
    0,
    0,
    0,
    -minute,
    -hour,
    -2 * day,
    -7 * day,
    -7 * day - 1,
    -8 * day,
    5 * minute,
    5 * minute + 1,
    hour
  )
  const charge = fc
    .record({ idempotencyKey: key, amount })
    .map(({ idempotencyKey, amount }): Planned => ({ type: "charge", idempotencyKey, amount }))
  const record = fc
    .record({ idempotencyKey: key, amount, occurredOffset })
    .map((planned): Planned => ({ type: "record-ref", ...planned }))
  const authorize = fc
    .record({ idempotencyKey: key, amount, ttlMs })
    .map(
      ({ idempotencyKey, amount, ttlMs }): Planned =>
        ttlMs === undefined
          ? { type: "authorize", idempotencyKey, amount }
          : { type: "authorize", idempotencyKey, amount, ttlMs }
    )
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
        { type: "settle", holdId: "hold_1", amount: scale },
        { type: "release", holdId: "h_0" }
      ),
    },
    { weight: 3, arbitrary: charge },
    { weight: 3, arbitrary: record },
    { weight: 3, arbitrary: fc.constant<Planned>({ type: "retry" }) },
    { weight: 2, arbitrary: fc.constant<Planned>({ type: "retry-record" }) },
    { weight: 2, arbitrary: upsert },
    { weight: 1, arbitrary: fc.constantFrom<Planned>({ type: "get" }, { type: "sweep" }) }
  )
}

function resolve(
  planned: Planned,
  previous: { command: BudgetCommand; record: BudgetCommand | null },
  holdCount: number,
  clock: number
): BudgetCommand {
  const holdId = (offset: number) => `h_${Math.max(0, holdCount - offset)}`
  switch (planned.type) {
    case "retry":
      return previous.command
    case "retry-record":
      return previous.record ?? { type: "get" }
    case "settle-ref":
      return { type: "settle", holdId: holdId(planned.offset), amount: planned.amount }
    case "release-ref":
      return { type: "release", holdId: holdId(planned.offset) }
    case "record-ref":
      return {
        type: "record",
        idempotencyKey: planned.idempotencyKey,
        amount: planned.amount,
        occurredAt: clock + planned.occurredOffset,
      }
    default:
      return planned
  }
}

const advanceArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(0, second, minute, 10 * minute) },
  { weight: 2, arbitrary: fc.constantFrom(hour, 6 * hour, day) },
  { weight: 1, arbitrary: fc.constantFrom(3 * day, 8 * day, 32 * day) },
  { weight: 1, arbitrary: fc.constantFrom(-minute, -2 * hour, -3 * day) },
  { weight: 1, arbitrary: fc.constantFrom<"hour-edge" | "day-edge">("hour-edge", "day-edge") }
)

function advance(clock: number, by: number | "hour-edge" | "day-edge"): number {
  if (by === "hour-edge") return Math.floor(clock / hour) * hour + hour
  if (by === "day-edge") return Math.floor(clock / day) * day + day
  return clock + by
}

const scenarioArb = scaleArb.chain((scale) =>
  fc.record({
    config: configArb(scale),
    steps: fc.array(
      fc.record({ advanceMs: advanceArb, alarm: fc.boolean(), planned: commandArb(scale) }),
      {
        minLength: 15,
        maxLength: 80,
      }
    ),
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
  const source =
    outcome.type === "upsert" || outcome.type === "get"
      ? { version: outcome.budget.version, closed: outcome.budget.closed }
      : outcome
  for (const key of Object.keys(expected)) picked[key] = (source as Record<string, unknown>)[key]
  return picked
}

function rolledInStore(store: MemoryBudgetStore): Period[] {
  return sortPeriods(
    [...store.history.values()].flatMap((periods) =>
      periods.map((p): Period => [p.windowId, p.start, p.end, p.consumed])
    )
  )
}

/** The store keeps the newest WINDOW_HISTORY_PERIODS of each window. */
function keptPeriods(periods: Period[]): Period[] {
  const kept = new Map<string, Period[]>()
  for (const period of [...periods].sort((a, b) => b[1] - a[1])) {
    const ofWindow = kept.get(period[0]) ?? []
    if (ofWindow.length < 12) kept.set(period[0], [...ofWindow, period])
  }
  return sortPeriods([...kept.values()].flat())
}

/** Per live counter: what the ledger counts in the current period against what the model attributes. */
function countersView(ledger: Ledger, model: ReferenceBudget, now: number) {
  const actual: Record<string, bigint> = {}
  const expected: Record<string, bigint> = {}
  for (const segment of model.segments) {
    if (segment.until !== null && now >= segment.until) continue
    expected[segment.id] = model.counted(segment, rangeOf(segment.window, segment.anchor, now))
  }
  for (const [id, counter] of countersOf(ledger.usage)) {
    const segment = model.segmentAt(id, now)
    const range = segment ? rangeOf(segment.window, segment.anchor, now) : null
    const current = id === "never" || counter.start === range?.start
    // A counter left behind in an ended period may only linger empty: its roll had nothing to say.
    if (current) actual[id] = counter.consumed
    else if (counter.consumed !== ZERO) actual[id] = -counter.consumed
    else if (segment) actual[id] = ZERO
  }
  return { actual, expected }
}

describe("budget core against a reference model", () => {
  it("agrees on every outcome, balance, counter, and window history", () => {
    fc.assert(
      fc.property(scenarioArb, ({ config, steps }) => {
        const store = new MemoryBudgetStore()
        const model = new ReferenceBudget()
        let clock = start
        /** Every event a record counted: its key, amount, and `occurredAt`. */
        const recordedEvents: string[] = []
        const previous: { command: BudgetCommand; record: BudgetCommand | null } = {
          command: {
            type: "upsert",
            key: "customer:acme",
            projectId: "proj_1",
            unit: "money:USD",
            config,
          },
          record: null,
        }
        const all: Array<{
          advanceMs: number | "hour-edge" | "day-edge"
          alarm: boolean
          planned: Planned
        }> = [{ advanceMs: 0, alarm: false, planned: previous.command }, ...steps]

        for (const step of all) {
          clock = advance(clock, step.advanceMs)
          const command = resolve(step.planned, previous, model.holdCount, clock)
          previous.command = command
          if (command.type === "record") previous.record = command
          if (step.alarm) {
            store.alarm(clock)
            model.alarm(clock)
          }
          const writesBefore = store.writes
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
            expect(store.writes).toBe(writesBefore)
            continue
          }
          if (result.err) throw result.err

          const { outcome, ledger } = result.val
          if (command.type === "record" && outcome.type === "record" && !outcome.replayed) {
            const { idempotencyKey, amount, occurredAt } = command
            recordedEvents.push(`${idempotencyKey}|${amount}|${occurredAt}`)
          }
          const now = Math.max(clock, model.lastWriteAt)
          expect(outcomeFields(outcome, expected.outcome)).toEqual(expected.outcome)
          if (expected.checkBalance) {
            const balance =
              "balance" in outcome
                ? outcome.balance
                : "budget" in outcome
                  ? outcome.budget.balance
                  : null
            const reference = model.balance(now)
            for (const limit of balance?.limits ?? []) {
              if (limit.enforce === "hard")
                expect(limit.consumed + limit.held <= limit.amount).toBe(true)
            }
            expect(balance && balanceView(balance)).toEqual({
              remaining: reference.remaining,
              held: reference.held,
              limits: reference.limits.map((l) => [l.id, l.remaining, l.resetsAt]),
            })
          }
          const counters = countersView(ledger, model, now)
          expect(counters.actual).toEqual(counters.expected)
          const rolled = model.rolledPeriods(now)
          expect(rolledInStore(store)).toEqual(keptPeriods(rolled))
          if (outcome.type === "get" && model.config) {
            const ids = [...new Set(model.config.limits.map(idOf))]
            expect(
              outcome.history.map((p): Period => [p.windowId, p.start, p.end, p.consumed])
            ).toEqual(
              ids.flatMap((id) =>
                rolled
                  .filter((p) => p[0] === id)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 12)
              )
            )
          }
          if (
            (command.type === "authorize" || command.type === "charge") &&
            !("replayed" in outcome && outcome.replayed) &&
            model.config?.closesAt != null
          ) {
            expect(now).toBeLessThan(model.config.closesAt)
          }
        }

        // One event is recorded at most once, ever: a retry inside the dedupe window replays, and
        // one after it is too late, because a retry resends the event's own `occurredAt`.
        expect(new Set(recordedEvents).size).toBe(recordedEvents.length)
      }),
      { numRuns: runs, seed }
    )
  })

  it("keeps the record dedupe window longer than any replay that is still accepted", () => {
    expect(RECORD_DEDUPE_MS - RECORD_ACCEPT_WINDOW_MS - RECORD_FUTURE_SKEW_MS).toBe(
      day - 5 * minute
    )
  })

  it("bounds anchored periods the same as the calendar for any anchor and instant", () => {
    const instant = fc.integer({
      min: Date.parse("1972-01-01T00:00:00.000Z"),
      max: Date.parse("2100-12-31T00:00:00.000Z"),
    })
    const monthEnd = fc
      .record({
        year: fc.integer({ min: 1972, max: 2099 }),
        month: fc.integer({ min: 0, max: 11 }),
      })
      .chain(({ year, month }) =>
        fc
          .record({
            day: fc.integer({ min: 28, max: 31 }),
            ms: fc.integer({ min: 0, max: day - 1 }),
          })
          .map(({ day: dd, ms }) => Date.UTC(year, month, 1) + (dd - 1) * day + ms)
      )
    fc.assert(
      fc.property(
        fc.constantFrom<Every>("day", "week", "month"),
        fc.oneof(instant, monthEnd),
        instant,
        (every, anchor, now) => {
          const range = anchoredRange(every, anchor, now)
          expect(anchoredWindowBounds(every, anchor, now)).toEqual(range)
          expect(range.start <= now && now < range.end).toBe(true)
        }
      ),
      { numRuns: runs * 10, seed }
    )
  })
})
