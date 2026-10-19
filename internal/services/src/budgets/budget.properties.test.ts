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
type Denial = { code: string; limitId?: string; remedy?: string }
type ModelReport = {
  seq: number
  final: boolean
  captured: bigint
  extend: bigint
  extended: bigint
  denied: Denial | null
  crossed: string[]
}
type ModelLease = {
  requested: bigint
  ttlMs: number
  granted: bigint
  captured: bigint
  expiresAt: number
  status: "open" | "closed" | "expired" | "refused"
  changedAt: number
  last: ModelReport | null
  /** What a refused lease said blocked it. */
  blocked?: { limitId: string; remedy: string }
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

/** A refused lease is the one rejection that is kept; `wrote` says whether this call wrote it. */
type Rejected = { error: string; limitId?: string; remedy?: string; wrote?: boolean }
type Expected = Rejected | { outcome: Record<string, unknown>; checkBalance: boolean }

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
  /** Accepted calls that changed the budget, per verb. */
  readonly calls: Record<string, number> = {
    upsert: 0,
    authorize: 0,
    settle: 0,
    release: 0,
    charge: 0,
    record: 0,
    lease: 0,
    report: 0,
  }
  readonly consumptions: Array<{ at: number; amount: bigint }> = []
  readonly holds = new Map<number, ModelHold>()
  readonly leases = new Map<string, ModelLease>()
  readonly keyed = new Map<string, KeyedRecord>()
  /** Every config in force, with when it took effect: a period reports under the one at its end. */
  readonly configs: Array<{ at: number; ids: Set<string> }> = []
  readonly segments: Segment[] = (["hour", "day", "week", "month", "never"] as const).map(
    (window) => ({ id: window, window, from: 0, until: null })
  )

  /**
   * A closed row answers until its retention ends at the command's clock: a hold or a charge for a
   * day after it closed, a record for 25 hours, a refused lease for 10 minutes. Only the alarm
   * deletes rows.
   */
  private holdLive(hold: ModelHold, now: number) {
    return hold.status === "open" || now < hold.changedAt + day
  }

  private leaseLive(lease: ModelLease, now: number) {
    if (lease.status === "open") return true
    return now < lease.changedAt + (lease.status === "refused" ? 10 * minute : day)
  }

  private keyedLive(rec: KeyedRecord, now: number) {
    if (rec.verb === "authorize") {
      const hold = this.holds.get(rec.holdNo)
      return hold !== undefined && this.holdLive(hold, now)
    }
    return now < rec.createdAt + (rec.verb === "record" ? 25 * hour : day)
  }

  /**
   * A sweep settles each open hold past its expiry at its full amount, and consumes each open
   * lease's whole grant, earliest expiry first and holds before leases: the timer cannot prove the
   * work or the process stopped, so each counts all it permitted.
   */
  private expire(now: number) {
    const due = [
      ...[...this.holds.entries()]
        .filter(([, hold]) => hold.status === "open" && hold.expiresAt <= now)
        .map(([n, hold]) => ({ at: hold.expiresAt, rank: n, hold, lease: undefined })),
      ...[...this.leases.values()]
        .filter((lease) => lease.status === "open" && lease.expiresAt <= now)
        .map((lease) => ({
          at: lease.expiresAt,
          rank: Number.MAX_SAFE_INTEGER,
          hold: undefined,
          lease,
        })),
    ].sort((x, y) => x.at - y.at || x.rank - y.rank)
    for (const { hold, lease } of due) {
      if (lease) {
        this.consumptions.push({ at: now, amount: lease.granted - lease.captured })
        Object.assign(lease, { captured: lease.granted, status: "expired", changedAt: now })
        continue
      }
      if (!hold) continue
      const settle = {
        actual: hold.amount,
        released: ZERO,
        expired: true,
        crossed: this.crossed(now, hold.amount),
      }
      this.consumptions.push({ at: now, amount: hold.amount })
      Object.assign(hold, { status: "settled", changedAt: now, settle })
    }
  }

  alarm(clock: number) {
    if (!this.config) return
    const now = Math.max(clock, this.lastWriteAt)
    this.lastWriteAt = now
    this.expire(now)
    this.rolledCount = this.rolledPeriods(now).length
    for (const [key, rec] of this.keyed) if (!this.keyedLive(rec, now)) this.keyed.delete(key)
    for (const [n, hold] of this.holds) if (!this.holdLive(hold, now)) this.holds.delete(n)
    for (const [key, lease] of this.leases) if (!this.leaseLive(lease, now)) this.leases.delete(key)
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

  /** Open holds count their amount; open leases what they were granted and have not reported. */
  held(): bigint {
    let held = ZERO
    for (const hold of this.holds.values()) if (hold.status === "open") held += hold.amount
    for (const lease of this.leases.values()) {
      if (lease.status === "open") held += lease.granted - lease.captured
    }
    return held
  }

  balance(now: number) {
    const config = this.config
    if (!config) throw new Error("no config")
    const held = this.held()
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
      .limits.filter((l) => l.consumed <= l.amount && l.consumed + amount > l.amount)
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

  /** What fits under every hard limit, never negative; null with no hard limit. */
  private room(now: number): bigint | null {
    const { remaining } = this.balance(now)
    if (remaining === null) return null
    return remaining > ZERO ? remaining : ZERO
  }

  private leaseView(leaseKey: string, lease: ModelLease) {
    const { granted, captured, expiresAt, status } = lease
    return { leaseKey, seq: lease.last?.seq ?? 0, granted, captured, expiresAt, status }
  }

  private reported(leaseKey: string, lease: ModelLease, replayed: boolean) {
    const last = lease.last
    if (!last) throw new Error(`lease ${leaseKey} has no report`)
    return {
      lease: this.leaseView(leaseKey, lease),
      extension: { requested: last.extend, granted: last.extended, denied: last.denied },
      released: last.final ? lease.granted - lease.captured : ZERO,
      crossed: last.crossed,
      replayed,
    }
  }

  /**
   * B10: debit first, grant what fits under every hard limit. Nothing fitting is a refusal that is
   * kept, so the same key replays it even after room returns. It changes no balance or count.
   */
  private grant(
    command: Extract<BudgetCommand, { type: "lease" }>,
    config: ModelConfig,
    now: number
  ) {
    const { leaseKey, amount, ttlMs } = command
    const stored = this.leases.get(leaseKey)
    const prior = stored && this.leaseLive(stored, now) ? stored : undefined
    if (prior) {
      if (prior.requested !== amount || prior.ttlMs !== ttlMs) {
        return { error: "IDEMPOTENCY_CONFLICT" }
      }
      if (prior.blocked) return { error: "LIMIT_EXCEEDED", ...prior.blocked, wrote: false }
      const outcome = { lease: this.leaseView(leaseKey, prior), replayed: true }
      return { outcome, wrote: false, checkBalance: true }
    }
    if (ttlMs < 1_000 || ttlMs > config.maxTtlMs) return { error: "INVALID_TTL" }
    if (config.closesAt !== null && now >= config.closesAt) return { error: "BUDGET_CLOSED" }
    const room = this.room(now)
    const granted = room === null || room >= amount ? amount : room
    const blocked = granted === ZERO ? this.block(now, amount) : null
    const lease: ModelLease = {
      requested: amount,
      ttlMs,
      granted,
      captured: ZERO,
      expiresAt: now + ttlMs,
      status: blocked ? "refused" : "open",
      changedAt: now,
      last: null,
      ...(blocked ? { blocked } : {}),
    }
    // Newest last, so a planned report can name a lease by its distance from the newest.
    this.leases.delete(leaseKey)
    this.leases.set(leaseKey, lease)
    if (blocked) return { error: "LIMIT_EXCEEDED", ...blocked, wrote: true }
    const outcome = { lease: this.leaseView(leaseKey, lease), replayed: false }
    return { outcome, wrote: true, checkBalance: true }
  }

  /**
   * A cumulative capture moves the reported part from held to consumed. A non-final report then
   * extends by what fits after it and renews below half the TTL; a final one returns the rest.
   */
  private report(
    command: Extract<BudgetCommand, { type: "report" }>,
    config: ModelConfig,
    now: number
  ) {
    const { leaseKey, seq, request } = command
    const stored = this.leases.get(leaseKey)
    const lease = stored && this.leaseLive(stored, now) ? stored : undefined
    // A refused lease was never granted.
    if (!lease || lease.status === "refused") return { error: "LEASE_NOT_FOUND" }
    const extend = request.final ? ZERO : request.extend
    const last = lease.last
    const retry =
      last?.seq === seq &&
      last.final === request.final &&
      last.captured === request.captured &&
      last.extend === extend
    if (retry)
      return { outcome: this.reported(leaseKey, lease, true), wrote: false, checkBalance: true }
    if (lease.status !== "open") return { error: "LEASE_CLOSED" }
    if (seq !== (last?.seq ?? 0) + 1) return { error: "LEASE_SEQ_CONFLICT" }
    if (request.captured < lease.captured || request.captured > lease.granted) {
      return { error: "LEASE_CAPTURE_OUT_OF_RANGE" }
    }
    if (!request.final && now >= lease.expiresAt) return { error: "LEASE_CLOSED" }

    const delta = request.captured - lease.captured
    const crossed = this.crossed(now, delta)
    if (delta > ZERO) this.consumptions.push({ at: now, amount: delta })
    lease.captured = request.captured
    let extended = ZERO
    let denied: Denial | null = null
    if (request.final) {
      Object.assign(lease, { status: "closed", changedAt: now })
    } else {
      const closed = config.closesAt !== null && now >= config.closesAt
      const room = closed ? ZERO : this.room(now)
      extended = room === null || room >= extend ? extend : room
      if (extended < extend) {
        denied = closed
          ? { code: "BUDGET_CLOSED" }
          : { code: "LIMIT_EXCEEDED", ...this.block(now, extend) }
      }
      lease.granted += extended
      if (2 * (lease.expiresAt - now) < lease.ttlMs) lease.expiresAt = now + lease.ttlMs
    }
    lease.last = {
      seq,
      final: request.final,
      captured: request.captured,
      extend,
      extended,
      denied,
      crossed,
    }
    return { outcome: this.reported(leaseKey, lease, false), wrote: true, checkBalance: true }
  }

  apply(command: BudgetCommand, clock: number): Expected {
    const now = Math.max(clock, this.lastWriteAt)
    const decided = this.decide(command, now)
    // A rejection writes nothing, except a refused lease, which is kept like an accepted command.
    if ("error" in decided && decided.wrote === undefined) return decided
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
    if ("error" in decided) return decided
    if (decided.wrote) this.calls[command.type] = (this.calls[command.type] ?? 0) + 1
    return { outcome: decided.outcome, checkBalance: decided.checkBalance }
  }

  private decide(
    command: BudgetCommand,
    now: number
  ): Rejected | { outcome: Record<string, unknown>; wrote: boolean; checkBalance: boolean } {
    if (command.type === "upsert") {
      const next: ModelConfig = {
        limits: command.config.limits.map((l) => ({ ...l })),
        defaultTtlMs: command.config.holds.defaultTtlMs,
        maxTtlMs: command.config.holds.maxTtlMs,
        closesAt: command.config.closesAt,
      }
      // A caller that may not loosen cannot close the budget before now, or before a close it
      // already passed: the deletion after a past close would let it recreate the budget uncapped.
      if (this.config && !command.mayLoosen && next.closesAt !== null) {
        const floor = this.config.closesAt === null ? now : Math.min(this.config.closesAt, now)
        next.closesAt = Math.max(next.closesAt, floor)
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
        if (!command.mayLoosen && loosens(this.config, next)) {
          return { error: "LOOSENING_FORBIDDEN" }
        }
        const held = this.held()
        for (const limit of next.limits) {
          const segment = this.segmentAt(idOf(limit), now)
          const consumed = segment
            ? this.counted(segment, rangeOf(limit.window, limit.anchor, now))
            : ZERO
          const before = this.config.limits.find((l) => l.id === limit.id)
          const kept = before?.enforce === "hard" && limit.amount >= before.amount
          if (limit.enforce === "hard" && limit.amount < consumed + held && !kept) {
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
    if (command.type === "sweep") {
      if (this.config) this.expire(now)
      return { outcome: {}, wrote: false, checkBalance: false }
    }
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
    if (command.type === "lease") return this.grant(command, config, now)
    if (command.type === "report") return this.report(command, config, now)

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
    if (occurredAt !== undefined && occurredAt < now - day) return { error: "TOO_LATE" }
    const grace = command.type === "record" ? day : 0
    if (config.closesAt !== null && now >= config.closesAt + grace) {
      return { error: "BUDGET_CLOSED" }
    }
    const blocked = command.type === "record" ? null : this.block(now, amount)
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

/** Whether `next` lets more spend through: a hard limit gone, soft, or higher, or a later close. */
function loosens(prev: ModelConfig, next: ModelConfig): boolean {
  const after = new Map(next.limits.map((limit) => [limit.id, limit]))
  const limitLoosened = prev.limits.some((limit) => {
    if (limit.enforce !== "hard") return false
    const kept = after.get(limit.id)
    return !kept || kept.enforce !== "hard" || kept.amount > limit.amount
  })
  const closeLoosened =
    prev.closesAt !== null && (next.closesAt === null || next.closesAt > prev.closesAt)
  return limitLoosened || closeLoosened
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
  /**
   * A report on a lease named by its distance from the newest one (else `leaseKey`): the next seq
   * or another, and a capture relative to the lease's state. Opens `leaseKey` when none exists.
   */
  | {
      type: "report-ref"
      offset: number
      leaseKey: string
      seqOffset: number
      capture: "same" | "half" | "all" | "below" | "above"
      final: boolean
      extend: bigint
    }

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
    -12 * hour,
    -day,
    -day - 1,
    -2 * day,
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
      mayLoosen: fc.constantFrom(true, true, false),
    })
    .map(
      ({ config, unit, mayLoosen }): Planned => ({
        type: "upsert",
        key: "customer:acme",
        projectId: "proj_1",
        unit,
        config,
        mayLoosen,
      })
    )
  const leaseKey = fc.constantFrom("l0", "l1", "l2")
  const lease = fc
    .record({
      leaseKey,
      amount,
      ttlMs: fc.constantFrom(second, minute, 15 * minute, hour, hour, 2 * hour, 500),
    })
    .map((planned): Planned => ({ type: "lease", ...planned }))
  const report = fc
    .record({
      offset: fc.constantFrom(0, 0, 0, 1, 2),
      leaseKey,
      seqOffset: fc.constantFrom(1, 1, 1, 1, 0, 2),
      capture: fc.constantFrom<"same" | "half" | "all" | "below" | "above">(
        "same",
        "half",
        "half",
        "all",
        "below",
        "above"
      ),
      final: fc.constantFrom(false, false, false, false, false, true),
      extend: amount,
    })
    .map((planned): Planned => ({ type: "report-ref", ...planned }))
  return fc.oneof(
    { weight: 5, arbitrary: authorize },
    { weight: 3, arbitrary: lease },
    { weight: 5, arbitrary: report },
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
  model: ReferenceBudget,
  clock: number
): BudgetCommand {
  const holdId = (offset: number) => `h_${Math.max(0, model.holdCount - offset)}`
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
    case "report-ref": {
      const { extend } = planned
      const keys = [...model.leases].flatMap(([key, lease]) =>
        lease.status === "refused" ? [] : [key]
      )
      // With no lease to report on, open one, so most reports find a lease.
      if (keys.length === 0) {
        return { type: "lease", leaseKey: planned.leaseKey, amount: extend, ttlMs: hour }
      }
      const leaseKey = keys.at(-1 - planned.offset) ?? planned.leaseKey
      const lease = model.leases.get(leaseKey)
      const seq = (lease?.last?.seq ?? 0) + planned.seqOffset
      const base = lease?.captured ?? ZERO
      const granted = lease?.granted ?? ZERO
      const captured = {
        same: base,
        half: base + (granted - base) / BigInt(2),
        all: granted,
        below: base > ZERO ? base - BigInt(1) : ZERO,
        above: granted + BigInt(1),
      }[planned.capture]
      return planned.final
        ? { type: "report", leaseKey, seq, request: { final: true, captured } }
        : { type: "report", leaseKey, seq, request: { final: false, captured, extend } }
    }
    default:
      return planned
  }
}

const advanceArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(0, second, minute, 10 * minute) },
  { weight: 2, arbitrary: fc.constantFrom(hour, 6 * hour, day) },
  { weight: 1, arbitrary: fc.constantFrom(25 * hour, 3 * day, 32 * day) },
  { weight: 1, arbitrary: fc.constantFrom(-minute, -2 * hour, -3 * day) },
  { weight: 1, arbitrary: fc.constantFrom<"hour-edge" | "day-edge">("hour-edge", "day-edge") }
)

function advance(clock: number, by: number | "hour-edge" | "day-edge"): number {
  if (by === "hour-edge") return Math.floor(clock / hour) * hour + hour
  if (by === "day-edge") return Math.floor(clock / day) * day + day
  return clock + by
}

/** Seconds between calls, so leases live through many reports before they expire. */
const steadyAdvanceArb = fc.constantFrom(0, second, 10 * second, minute)

const scenarioArb = fc.tuple(scaleArb, fc.boolean()).chain(([scale, steady]) =>
  fc.record({
    config: configArb(scale),
    steps: fc.array(
      fc.record({
        advanceMs: steady ? steadyAdvanceArb : advanceArb,
        alarm: fc.boolean(),
        planned: commandArb(scale),
      }),
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
  let source: object = outcome
  if (outcome.type === "upsert" || outcome.type === "get") {
    source = { version: outcome.budget.version, closed: outcome.budget.closed }
  } else if (outcome.type === "report") {
    const { denied } = outcome.extension
    const projected =
      denied?.code === "LIMIT_EXCEEDED"
        ? { code: denied.code, limitId: denied.blocked.limitId, remedy: denied.blocked.remedy }
        : denied && { code: denied.code }
    source = { ...outcome, extension: { ...outcome.extension, denied: projected } }
  }
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
  // A few hundred milliseconds alone, but the pre-commit hook runs every package's tests at once.
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
            mayLoosen: true,
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
          const command = resolve(step.planned, previous, model, clock)
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
            const kept = result.err || result.val.ok ? undefined : result.val.rejection
            const rejection = result.err?.rejection ?? kept
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
            // A kept refusal may also write the roll of an ended period; any other rejection writes
            // nothing.
            if (expected.wrote === undefined) expect(store.writes).toBe(writesBefore)
            else expect(kept).toBeDefined()
            continue
          }
          if (result.err) throw result.err
          if (!result.val.ok) throw new Error(`unexpected ${result.val.rejection.code}`)

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
            // Only a record passes a hard limit, so admitted gated spend always fits.
            const admitted =
              (outcome.type === "authorize" ||
                outcome.type === "charge" ||
                outcome.type === "lease") &&
              !outcome.replayed
            for (const limit of admitted ? (balance?.limits ?? []) : []) {
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
          expect(ledger.operations).toEqual(model.calls)
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
            (command.type === "authorize" ||
              command.type === "charge" ||
              command.type === "lease") &&
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
  }, 120_000)

  it("keeps the record dedupe window longer than any replay that is still accepted", () => {
    expect(RECORD_DEDUPE_MS - RECORD_ACCEPT_WINDOW_MS - RECORD_FUTURE_SKEW_MS).toBe(
      hour - 5 * minute
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
