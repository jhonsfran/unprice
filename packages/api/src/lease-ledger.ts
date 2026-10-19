import { type AmountInput, toDecimal } from "./budgets"

/** A decimal amount at scale 8 as base units: `"0.05"` is `5_000_000`. */
export type Units = bigint

const SCALE = 8
const ONE = BigInt(10 ** SCALE)
const ZERO = BigInt(0)
const DECIMAL = /^\d{1,19}(\.\d{1,8})?$/

/** The budget API's minimum hold TTL. */
const MIN_HOLD_TTL_MS = 1_000
/** Closed holds and charges remembered for replay; the oldest closed ones are forgotten first. */
const REMEMBERED_KEYS = 100_000

/**
 * Base units of a non-negative decimal with at most 8 places, or null for anything else.
 * Throws RangeError for a non-finite number, like the remote handle.
 */
export function toUnits(amount: AmountInput): Units | null {
  const text = toDecimal(amount)
  if (!DECIMAL.test(text)) return null
  const [whole = "0", fraction = ""] = text.split(".")
  return BigInt(whole) * ONE + BigInt(fraction.padEnd(SCALE, "0"))
}

/** The canonical decimal the API returns: no trailing zeros, no exponent. */
export function fromUnits(units: Units): string {
  const negative = units < ZERO
  const abs = negative ? -units : units
  const fraction = (abs % ONE).toString().padStart(SCALE, "0").replace(/0+$/, "")
  return `${negative ? "-" : ""}${abs / ONE}${fraction ? `.${fraction}` : ""}`
}

export type LeaseTerms = Readonly<{
  holds: Readonly<{ defaultTtlMs: number; maxTtlMs: number }>
  closesAt: number | null
}>

/** The server's answer to a grant or a report, in base units. */
export type LeaseGrant = Readonly<{
  leaseKey: string
  seq: number
  granted: Units
  captured: Units
  expiresAt: number
  /** The server clock when it answered. */
  asOf: number
  terms: LeaseTerms
}>

/**
 * One report as sent. Once frozen it never changes, so a retry after a lost response repeats it
 * field by field. `captured` is cumulative.
 */
export type FrozenReport = Readonly<{ seq: number; captured: Units }> &
  (Readonly<{ final: false; extend: Units }> | Readonly<{ final: true }>)

type HoldState =
  | Readonly<{ status: "open" }>
  | Readonly<{ status: "settled"; actual: Units; expired: boolean }>
  | Readonly<{ status: "released" }>

type Hold = {
  readonly id: string
  readonly idempotencyKey: string
  readonly amount: Units
  /** As requested, so a replay must repeat it. */
  readonly ttlMs: number | null
  readonly expiresAt: number
  state: HoldState
}

export type LocalHold = Readonly<Hold>

type Remembered =
  | Readonly<{ kind: "hold"; hold: Hold }>
  | Readonly<{ kind: "charge"; amount: Units }>

/** The answers the API would give, decided from memory. */
export type LocalRejection =
  | Readonly<{ code: "IDEMPOTENCY_CONFLICT"; idempotencyKey: string }>
  | Readonly<{ code: "INVALID_TTL"; ttlMs: number; minTtlMs: number; maxTtlMs: number }>
  | Readonly<{ code: "BUDGET_CLOSED"; closedAt: number }>
  | Readonly<{ code: "HOLD_AMOUNT_EXCEEDED"; holdId: string; maximum: Units; actual: Units }>
  | Readonly<{ code: "HOLD_CLOSED"; holdId: string; status: "settled" | "released" | "expired" }>
  | Readonly<{ code: "HOLD_RETIRED"; holdId: string }>

export type HoldDecision<T> =
  | Readonly<{ kind: "ok"; value: T }>
  | Readonly<{ kind: "rejected"; rejection: LocalRejection }>

/**
 * `short`: the lease cannot cover the request. `stale`: no answer since the local deadline, so the
 * lease may be gone. `ended`: the lease is closing or closed; spend from a new one.
 */
export type SpendDecision<T> =
  | HoldDecision<T>
  | Readonly<{ kind: "short" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "ended" }>

export type LeaseTotals = Readonly<{
  granted: Units
  available: Units
  held: Units
  consumed: Units
  /** The last capture the server acknowledged. */
  captured: Units
}>

const ok = <T>(value: T) => ({ kind: "ok", value }) as const
const rejected = (rejection: LocalRejection) => ({ kind: "rejected", rejection }) as const
const min = (a: number, b: number) => (a < b ? a : b)

/**
 * One lease spent in memory (ADR-0006 B10). Pure: no timers, no I/O; callers pass the clock.
 * Invariant: `granted = available + held + consumed`. Local holds follow the API's rules (B3): an
 * amount is fixed, a settle takes at most it, an expired hold settles at its full amount, and a
 * repeated idempotency key replays while the lease remembers it.
 */
export class LeaseLedger {
  readonly leaseKey: string
  private granted: Units
  private held = ZERO
  private consumed = ZERO
  private acked: Readonly<{ seq: number; captured: Units }>
  private frozen: FrozenReport | null = null
  private state: "open" | "closing" | "ended" = "open"
  private terms: LeaseTerms
  private deadlineAt: number
  private holdSeq = 0
  private nextExpiry = Number.POSITIVE_INFINITY
  private readonly holds = new Map<string, Hold>()
  private readonly open = new Set<Hold>()
  private readonly keys = new Map<string, Remembered>()

  constructor(grant: LeaseGrant, sentAt: number) {
    this.leaseKey = grant.leaseKey
    this.granted = grant.granted
    this.acked = { seq: grant.seq, captured: grant.captured }
    this.consumed = grant.captured
    this.terms = grant.terms
    this.deadlineAt = deadlineOf(grant, sentAt)
  }

  get phase(): "open" | "closing" | "ended" {
    return this.state
  }

  /** The local time past which spending stops until the server answers again. */
  get deadline(): number {
    return this.deadlineAt
  }

  /** The report sent and not yet acknowledged: a retry must resend exactly this. */
  get pending(): FrozenReport | null {
    return this.frozen
  }

  available(): Units {
    return this.granted - this.held - this.consumed
  }

  /** Consumption the server has not acknowledged yet. */
  dirty(): boolean {
    return this.consumed !== this.acked.captured
  }

  totals(): LeaseTotals {
    const { granted, held, consumed } = this
    return { granted, available: this.available(), held, consumed, captured: this.acked.captured }
  }

  authorize(
    input: Readonly<{ amount: Units; idempotencyKey: string; ttlMs?: number | undefined }>,
    now: number
  ): SpendDecision<Readonly<{ hold: LocalHold; replayed: boolean }>> {
    this.expire(now)
    const { amount, idempotencyKey } = input
    const ttlMs = input.ttlMs ?? null
    const known = this.keys.get(idempotencyKey)
    if (known) {
      if (known.kind === "hold" && known.hold.amount === amount && known.hold.ttlMs === ttlMs) {
        return ok({ hold: known.hold, replayed: true })
      }
      return rejected({ code: "IDEMPOTENCY_CONFLICT", idempotencyKey })
    }

    const { holds } = this.terms
    const ttl = ttlMs ?? holds.defaultTtlMs
    if (!Number.isSafeInteger(ttl) || ttl < MIN_HOLD_TTL_MS || ttl > holds.maxTtlMs) {
      return rejected({
        code: "INVALID_TTL",
        ttlMs: ttl,
        minTtlMs: MIN_HOLD_TTL_MS,
        maxTtlMs: holds.maxTtlMs,
      })
    }
    const refused = this.admit(amount, now)
    if (refused) return refused

    const hold: Hold = {
      id: `${this.leaseKey}:h_${++this.holdSeq}`,
      idempotencyKey,
      amount,
      ttlMs,
      expiresAt: now + ttl,
      state: { status: "open" },
    }
    this.held += amount
    this.holds.set(hold.id, hold)
    this.open.add(hold)
    this.nextExpiry = min(this.nextExpiry, hold.expiresAt)
    this.remember(idempotencyKey, { kind: "hold", hold })
    return ok({ hold, replayed: false })
  }

  charge(
    input: Readonly<{ amount: Units; idempotencyKey: string }>,
    now: number
  ): SpendDecision<Readonly<{ amount: Units; replayed: boolean }>> {
    this.expire(now)
    const { amount, idempotencyKey } = input
    const known = this.keys.get(idempotencyKey)
    if (known) {
      if (known.kind === "charge" && known.amount === amount) return ok({ amount, replayed: true })
      return rejected({ code: "IDEMPOTENCY_CONFLICT", idempotencyKey })
    }
    const refused = this.admit(amount, now)
    if (refused) return refused

    this.consumed += amount
    this.remember(idempotencyKey, { kind: "charge", amount })
    return ok({ amount, replayed: false })
  }

  settle(
    holdId: string,
    actual: Units,
    now: number
  ): HoldDecision<
    Readonly<{ actual: Units; released: Units; expired: boolean; replayed: boolean }>
  > {
    this.expire(now)
    const hold = this.holds.get(holdId)
    if (!hold) return rejected({ code: "HOLD_RETIRED", holdId })
    const { amount, state } = hold
    switch (state.status) {
      case "settled":
        if (state.actual === actual) {
          return ok({ actual, released: amount - actual, expired: state.expired, replayed: true })
        }
        return rejected({ code: "HOLD_CLOSED", holdId, status: closedStatus(state) })
      case "released":
        return rejected({ code: "HOLD_CLOSED", holdId, status: "released" })
      case "open":
        if (actual > amount) {
          return rejected({ code: "HOLD_AMOUNT_EXCEEDED", holdId, maximum: amount, actual })
        }
        this.close(hold, { status: "settled", actual, expired: false })
        return ok({ actual, released: amount - actual, expired: false, replayed: false })
    }
  }

  release(
    holdId: string,
    now: number
  ): HoldDecision<Readonly<{ released: Units; replayed: boolean }>> {
    this.expire(now)
    const hold = this.holds.get(holdId)
    if (!hold) return rejected({ code: "HOLD_RETIRED", holdId })
    const { amount, state } = hold
    switch (state.status) {
      case "released":
        return ok({ released: amount, replayed: true })
      case "settled":
        return rejected({ code: "HOLD_CLOSED", holdId, status: closedStatus(state) })
      case "open":
        this.close(hold, { status: "released" })
        return ok({ released: amount, replayed: false })
    }
  }

  /** Settles every open hold past its `expiresAt` at its full amount (B3). */
  expire(now: number): void {
    if (now < this.nextExpiry) return
    let next = Number.POSITIVE_INFINITY
    for (const hold of this.open) {
      if (hold.expiresAt <= now) this.close(hold, expiredState(hold))
      else next = min(next, hold.expiresAt)
    }
    this.nextExpiry = next
  }

  /**
   * The report to send: the pending one when a report is unacknowledged, else the next seq with
   * the cumulative capture. A final report counts open holds at their full amount, because the
   * work they cover may still be running, and stops all spending from this lease.
   */
  freeze(params: Readonly<{ final: boolean; extend: Units }>, now: number): FrozenReport {
    this.expire(now)
    if (this.frozen) return this.frozen
    if (this.state !== "open") throw new Error(`lease ${this.leaseKey} is ${this.state}`)
    const seq = this.acked.seq + 1
    if (params.final) {
      this.closeOpenHolds()
      this.state = "closing"
      this.frozen = { seq, captured: this.consumed, final: true }
    } else {
      this.frozen = { seq, captured: this.consumed, final: false, extend: params.extend }
    }
    return this.frozen
  }

  /** Applies the server's answer to the pending report. */
  acknowledge(report: FrozenReport, grant: LeaseGrant, sentAt: number): void {
    if (report !== this.frozen) throw new Error(`report ${report.seq} is not the pending report`)
    this.frozen = null
    this.acked = { seq: grant.seq, captured: grant.captured }
    this.granted = grant.granted
    this.terms = grant.terms
    this.deadlineAt = deadlineOf(grant, sentAt)
    if (report.final) this.state = "ended"
  }

  /** The server ended the lease without a final report from us: open holds count in full. */
  retire(): void {
    this.closeOpenHolds()
    this.frozen = null
    this.state = "ended"
  }

  private admit(amount: Units, now: number) {
    const { closesAt } = this.terms
    if (closesAt !== null && now >= closesAt) {
      return rejected({ code: "BUDGET_CLOSED", closedAt: closesAt })
    }
    if (this.state !== "open") return { kind: "ended" } as const
    if (now >= this.deadlineAt) return { kind: "stale" } as const
    if (amount > this.available()) return { kind: "short" } as const
    return null
  }

  private close(hold: Hold, state: Exclude<HoldState, { status: "open" }>): void {
    hold.state = state
    this.open.delete(hold)
    this.held -= hold.amount
    if (state.status === "settled") this.consumed += state.actual
  }

  private closeOpenHolds(): void {
    for (const hold of this.open) this.close(hold, expiredState(hold))
    this.nextExpiry = Number.POSITIVE_INFINITY
  }

  private remember(idempotencyKey: string, entry: Remembered): void {
    this.keys.set(idempotencyKey, entry)
    if (this.keys.size <= REMEMBERED_KEYS) return
    for (const [key, old] of this.keys) {
      if (old.kind === "hold" && old.hold.state.status === "open") continue
      this.keys.delete(key)
      if (old.kind === "hold") this.holds.delete(old.hold.id)
      return
    }
  }
}

const expiredState = (hold: Hold) =>
  ({ status: "settled", actual: hold.amount, expired: true }) as const

const closedStatus = (state: Extract<HoldState, { status: "settled" }>) =>
  state.expired ? "expired" : "settled"

// `sentAt` precedes the server's answer, so this is never later than the server's own expiry.
const deadlineOf = (grant: LeaseGrant, sentAt: number) => sentAt + (grant.expiresAt - grant.asOf)
