/**
 * Policy (ADR-0006 B1-B3): every rule that accepts or rejects a command. Returns the change it
 * makes or a rejection; applying the change to the ledger is `transition`'s job.
 */

import { Ok, type Result } from "@unprice/error"
import type { Amount, SignedAmount } from "@unprice/money"
import {
  type BudgetConfig,
  type BudgetRecord,
  type ConfigChange,
  MAX_RETAINED_ANCHORED_WINDOWS,
  MIN_HOLD_TTL_MS,
  OPERATION_RETENTION_MS,
  RECORD_ACCEPT_WINDOW_MS,
  RECORD_FUTURE_SKEW_MS,
  closeNoEarlierThanNow,
  diffConfig,
  isClosed,
  loosening,
} from "./config"
import { consume, exposureOf } from "./ledger"
import {
  type Blocked,
  type BlockedRemedy,
  type BudgetBalance,
  type BudgetCommand,
  type BudgetRejection,
  type BudgetView,
  type ChargeOperation,
  type ExtensionDenial,
  type HoldOperation,
  type LeaseOperation,
  type LeaseReportRequest,
  type Ledger,
  type LimitBalance,
  type Operation,
  type ReservationOperation,
  type UnPriceBudgetError,
  reject,
} from "./model"
import { windowBounds, windowIdOf } from "./windows"

const ZERO = BigInt(0)

type Funded = Readonly<{ budget: BudgetRecord; ledger: Ledger }>

// Reads

/** Pure read at `now` (clamped to `lastAt`). Windows roll virtually; nothing is written. */
export function balanceOf(state: Funded, now: number): BudgetBalance {
  const { ledger } = state
  const at = Math.max(now, ledger.lastAt)
  let remaining: SignedAmount | null = null
  const limits = state.budget.config.limits.map((limit): LimitBalance => {
    const bounds = windowBounds(limit, at)
    const usage = ledger.usage[windowIdOf(limit)]
    const consumed = !usage || bounds.start > usage.start ? ZERO : usage.consumed
    const limitRemaining = limit.amount - consumed - ledger.held
    if (limit.enforce === "hard" && (remaining === null || limitRemaining < remaining)) {
      remaining = limitRemaining
    }
    return {
      id: limit.id,
      window: limit.window,
      enforce: limit.enforce,
      amount: limit.amount,
      consumed,
      held: ledger.held,
      remaining: limitRemaining,
      resetsAt: bounds.end,
    }
  })
  return { remaining, held: ledger.held, limits, asOf: at }
}

/** What would deny a request for `amount` at this balance; null when it fits every hard limit. */
export function blockingLimit(balance: BudgetBalance, amount: Amount): Blocked | null {
  const failing = balance.limits.filter(
    (limit) => limit.enforce === "hard" && limit.remaining < amount
  )
  let blocking: LimitBalance | undefined = failing[0]
  if (!blocking) return null
  for (const limit of failing.slice(1)) {
    if (resetsLater(limit.resetsAt, blocking.resetsAt)) blocking = limit
  }
  let remedy: BlockedRemedy = "raise_limit"
  if (failing.every((limit) => limit.consumed + amount <= limit.amount)) {
    remedy = "release_holds"
  } else if (
    failing.every((limit) => limit.resetsAt !== null && limit.held + amount <= limit.amount)
  ) {
    remedy = "wait_for_reset"
  }
  if (remedy === "raise_limit")
    blocking = failing.find((limit) => amount > limit.amount) ?? blocking
  return {
    limitId: blocking.id,
    window: blocking.window,
    remaining: blocking.remaining,
    held: blocking.held,
    resetsAt: blocking.resetsAt,
    remedy,
  }
}

/** Admission for new work. Probes use the same closure and hard-limit policy as authorization. */
export function admissionRejection(
  config: Pick<BudgetConfig, "closesAt">,
  balance: BudgetBalance,
  amount: Amount,
  now: number
): Extract<BudgetRejection, { code: "BUDGET_CLOSED" | "LIMIT_EXCEEDED" }> | null {
  if (config.closesAt !== null && isClosed(config, now)) {
    return { code: "BUDGET_CLOSED", closedAt: config.closesAt }
  }
  const blocked = blockingLimit(balance, amount)
  return blocked ? { code: "LIMIT_EXCEEDED", blocked, balance } : null
}

/** What fits under every hard limit at this balance, never negative; null with no hard limit. */
function roomOf(balance: BudgetBalance): Amount | null {
  if (balance.remaining === null) return null
  return balance.remaining > ZERO ? balance.remaining : ZERO
}

function resetsLater(a: number | null, b: number | null): boolean {
  if (b === null) return false
  return a === null || a > b
}

/**
 * Limits whose consumed amount first exceeds their amount, after `prior` more was consumed since
 * `balance` was read. A hard limit gets there only after recorded usage took the room its holds
 * and charges were checked against.
 */
function crossings(balance: BudgetBalance, amount: Amount, prior = ZERO): string[] {
  return balance.limits
    .filter((limit) => {
      const consumed = limit.consumed + prior
      return consumed <= limit.amount && consumed + amount > limit.amount
    })
    .map((limit) => limit.id)
}

// Decide

/**
 * What one accepted command changes. `rows` are the rows it wrote, as new objects; `row` is the row
 * its outcome reads, written or replayed. No rows and no config is a read or an idempotent replay.
 */
export type Change = Readonly<{
  configured?: Readonly<{ budget: BudgetRecord; changes: readonly ConfigChange[] }>
  rows: readonly Operation[]
  row: Operation | null
  held: SignedAmount
  consumed: Amount
}>

const unchanged = (row: Operation | null): Change => ({ rows: [], row, held: ZERO, consumed: ZERO })

/**
 * Policy for one command against a view rolled to the clamped clock.
 * A rejection writes nothing.
 */
export function decide(
  command: BudgetCommand,
  view: Pick<BudgetView, "budget" | "ledger" | "target" | "expired">,
  now: number
): Result<Change, UnPriceBudgetError> {
  if (command.type === "upsert") return decideUpsert(command, view.budget, view.ledger, now)
  const budget = view.budget
  if (command.type === "sweep") {
    return Ok(
      budget ? decideSweep({ budget, ledger: view.ledger }, view.expired, now) : unchanged(null)
    )
  }
  if (budget) return decideVerb(command, { budget, ledger: view.ledger }, view.target, now)

  // A keyed verb may carry the budget to create when its key has none (ADR-0006 D8). The verb
  // then runs against the new budget in the same change, so a denial creates nothing.
  const definition = "ifMissing" in command ? command.ifMissing : undefined
  if (!definition) return reject({ code: "BUDGET_NOT_FOUND" })
  const created = decideUpsert(
    { type: "upsert", ...definition, mayLoosen: false },
    null,
    view.ledger,
    now
  )
  if (created.err) return created
  const { configured } = created.val
  if (!configured) throw new Error(`creating ${definition.key} configured nothing`)
  const decided = decideVerb(
    command,
    { budget: configured.budget, ledger: view.ledger },
    view.target,
    now
  )
  if (decided.err) return decided
  return Ok({ ...decided.val, configured })
}

function decideVerb(
  command: Exclude<BudgetCommand, { type: "upsert" | "sweep" }>,
  state: Funded,
  target: Operation | null,
  now: number
): Result<Change, UnPriceBudgetError> {
  switch (command.type) {
    case "get":
      return Ok(unchanged(null))
    case "authorize":
    case "charge":
    case "record":
      return decideKeyed(command, state, target, now)
    case "settle":
      return decideSettle(command, state, target, now)
    case "release":
      return decideRelease(command, state.ledger, target, now)
    case "lease":
      return decideLease(command, state, target, now)
    case "report":
      return decideReport(command, state, target, now)
  }
}

function decideUpsert(
  command: Extract<BudgetCommand, { type: "upsert" }>,
  budget: BudgetRecord | null,
  ledger: Ledger,
  now: number
): Result<Change, UnPriceBudgetError> {
  const { key, projectId, unit, config } = command
  if (!budget) {
    const changes = config.limits.map((limit) => ({
      change: "limit.added" as const,
      limitId: limit.id,
    }))
    const created = { key, projectId, unit, version: 1, config }
    return Ok({ ...unchanged(null), configured: { budget: created, changes } })
  }
  if (budget.key !== key || budget.projectId !== projectId) {
    throw new Error(
      `budget ${budget.projectId}/${budget.key} received upsert for ${projectId}/${key}`
    )
  }
  if (budget.unit !== unit) {
    return reject({ code: "UNIT_IMMUTABLE", current: budget.unit, requested: unit })
  }
  const windows = new Map(budget.config.limits.map((limit) => [limit.id, windowIdOf(limit)]))
  for (const limit of config.limits) {
    const current = windows.get(limit.id)
    const requested = windowIdOf(limit)
    if (current !== undefined && current !== requested) {
      return reject({ code: "LIMIT_WINDOW_IMMUTABLE", limitId: limit.id, current, requested })
    }
  }
  // A removed limit's anchored counter stays until its period ends, so it counts against the bound
  // that keeps the counters every command rewrites small.
  const retained = new Set(Object.keys(ledger.usage).filter((id) => id.includes("@")))
  const requested = new Set(
    config.limits.filter((limit) => limit.anchor !== undefined).map(windowIdOf)
  )
  const added = [...requested].filter((id) => !retained.has(id))
  if (added.length > 0 && retained.size + added.length > MAX_RETAINED_ANCHORED_WINDOWS) {
    return reject({
      code: "WINDOW_CAPACITY_EXCEEDED",
      maximum: MAX_RETAINED_ANCHORED_WINDOWS,
      retained: retained.size,
    })
  }
  const next = command.mayLoosen ? config : closeNoEarlierThanNow(budget.config, config, now)
  const changes = diffConfig(budget.config, next)
  if (changes.length === 0) return Ok(unchanged(null))
  const loosened = command.mayLoosen ? null : loosening(budget.config, next)
  if (loosened) return reject({ code: "LOOSENING_FORBIDDEN", change: loosened })
  const updated = { ...budget, version: budget.version + 1, config: next }
  const balance = balanceOf({ budget: updated, ledger }, now)
  const previous = new Map(budget.config.limits.map((limit) => [limit.id, limit]))
  for (const limit of balance.limits) {
    // A record may already have passed a hard limit; an upsert may keep or raise it, never tighten.
    const before = previous.get(limit.id)
    const tightened = before?.enforce !== "hard" || limit.amount < before.amount
    if (limit.enforce === "hard" && limit.remaining < ZERO && tightened) {
      return reject({
        code: "LIMIT_BELOW_USAGE",
        limitId: limit.id,
        minimum: limit.consumed + limit.held,
        requested: limit.amount,
      })
    }
  }
  return Ok({ ...unchanged(null), configured: { budget: updated, changes } })
}

/**
 * Closes every expired reservation into consumption of all it still holds: a timer cannot prove
 * the work or the process stopped, so a hold counts everything it permitted and a lease everything
 * it was granted. Held capacity becomes consumption in the current window and returns when that
 * window rolls. A late settle of a hold's full amount replays; another is refused.
 */
function decideSweep(state: Funded, expired: readonly ReservationOperation[], now: number): Change {
  const balance = balanceOf(state, now)
  let consumed = ZERO
  const rows = expired.map((row): ReservationOperation => {
    if (row.state.status !== "open" || row.expiresAt > now) {
      throw new Error(`${row.kind} ${row.id} is not open past its expiry`)
    }
    const exposure = exposureOf(row)
    const prior = consumed
    consumed += exposure
    if (row.kind === "lease") {
      return { ...row, captured: row.granted, state: { status: "expired", closedAt: now } }
    }
    const crossed = crossings(balance, exposure, prior)
    return {
      ...row,
      state: { status: "settled", closedAt: now, actual: row.amount, crossed, byExpiry: true },
    }
  })
  return { rows, row: null, held: -consumed, consumed }
}

/** A keyed command repeats its row when the verb, the amount, and (for a hold) the TTL match. */
function sameRequest(
  row: HoldOperation | ChargeOperation,
  command: Extract<BudgetCommand, { type: "authorize" | "charge" | "record" }>
): boolean {
  if (row.amount !== command.amount) return false
  if (command.type !== "authorize") return row.kind === command.type
  return row.kind === "hold" && row.ttlMs === (command.ttlMs ?? null)
}

function decideKeyed(
  command: Extract<BudgetCommand, { type: "authorize" | "charge" | "record" }>,
  state: Funded,
  target: Operation | null,
  now: number
): Result<Change, UnPriceBudgetError> {
  const { amount, idempotencyKey } = command
  if (target) {
    if (target.kind === "lease" || target.idempotencyKey !== idempotencyKey) {
      throw new Error(`target ${target.id} is not the row for key ${idempotencyKey}`)
    }
    if (sameRequest(target, command)) return Ok(unchanged(target))
    return reject({ code: "IDEMPOTENCY_CONFLICT", idempotencyKey })
  }

  let ttlMs = 0
  if (command.type === "authorize") {
    const { holds } = state.budget.config
    ttlMs = command.ttlMs ?? holds.defaultTtlMs
    const invalid = invalidTtl(ttlMs, holds.maxTtlMs)
    if (invalid) return invalid
  }

  if (command.type === "record") {
    const { occurredAt } = command
    const latestAccepted = now + RECORD_FUTURE_SKEW_MS
    if (occurredAt > latestAccepted) {
      return reject({ code: "INVALID_OCCURRED_AT", occurredAt, latestAccepted })
    }
    const oldestAccepted = now - RECORD_ACCEPT_WINDOW_MS
    if (occurredAt < oldestAccepted) return reject({ code: "TOO_LATE", occurredAt, oldestAccepted })
  }
  const { config } = state.budget
  if (
    command.type === "record" &&
    config.closesAt !== null &&
    isClosed(config, now, OPERATION_RETENTION_MS)
  ) {
    return reject({ code: "BUDGET_CLOSED", closedAt: config.closesAt })
  }

  const balance = balanceOf(state, now)
  // Recorded work already ran: refusing it would lose the count, not the spend.
  const rejection =
    command.type === "record" ? null : admissionRejection(config, balance, amount, now)
  if (rejection) return reject(rejection)

  if (command.type === "authorize") {
    const expiresAt = now + ttlMs
    const hold: HoldOperation = {
      kind: "hold",
      id: `h_${state.ledger.holdSeq + 1}`,
      idempotencyKey,
      amount,
      ttlMs: command.ttlMs ?? null,
      createdAt: now,
      expiresAt,
      state: { status: "open" },
    }
    return Ok({ rows: [hold], row: hold, held: amount, consumed: ZERO })
  }
  const row: Operation = {
    kind: command.type,
    id: `o:${idempotencyKey}`,
    idempotencyKey,
    amount,
    createdAt: now,
    crossed: crossings(balance, amount),
  }
  return Ok({ rows: [row], row, held: ZERO, consumed: amount })
}

/** A hold's or a lease's TTL: from MIN_HOLD_TTL_MS up to the budget's `holds.maxTtlMs`. */
function invalidTtl(ttlMs: number, maxTtlMs: number) {
  if (Number.isSafeInteger(ttlMs) && ttlMs >= MIN_HOLD_TTL_MS && ttlMs <= maxTtlMs) return null
  return reject({ code: "INVALID_TTL", ttlMs, minTtlMs: MIN_HOLD_TTL_MS, maxTtlMs })
}

/**
 * Debits first, against every hard limit, like an authorize, and grants what fits: near a limit
 * less than asked for. Nothing fitting is written as a refused lease: a lease key's first answer is
 * final, so a late copy of a refused request cannot take capacity no process holds. The same key,
 * amount, and TTL replay the grant or the refusal.
 */
function decideLease(
  command: Extract<BudgetCommand, { type: "lease" }>,
  state: Funded,
  target: Operation | null,
  now: number
): Result<Change, UnPriceBudgetError> {
  const { leaseKey, amount, ttlMs } = command
  if (target) {
    const lease = leaseOf(target, leaseKey)
    if (lease.requested === amount && lease.ttlMs === ttlMs) return Ok(unchanged(lease))
    return reject({ code: "IDEMPOTENCY_CONFLICT", idempotencyKey: leaseKey })
  }
  const { config } = state.budget
  const invalid = invalidTtl(ttlMs, config.holds.maxTtlMs)
  if (invalid) return invalid
  if (config.closesAt !== null && isClosed(config, now)) {
    return reject({ code: "BUDGET_CLOSED", closedAt: config.closesAt })
  }
  const balance = balanceOf(state, now)
  const room = roomOf(balance)
  const granted = room === null || room >= amount ? amount : room
  const blocked = granted === ZERO ? blockingLimit(balance, amount) : null
  const lease: LeaseOperation = {
    kind: "lease",
    id: `l:${leaseKey}`,
    leaseKey,
    requested: amount,
    ttlMs,
    createdAt: now,
    granted,
    captured: ZERO,
    last: null,
    expiresAt: now + ttlMs,
    state: blocked ? { status: "refused", closedAt: now, blocked } : { status: "open" },
  }
  return Ok({ rows: [lease], row: lease, held: granted, consumed: ZERO })
}

function sameReport(a: LeaseReportRequest, b: LeaseReportRequest): boolean {
  if (a.captured !== b.captured) return false
  return a.final || b.final ? a.final === b.final : a.extend === b.extend
}

/**
 * One report, one transaction. It moves the capture delta from held to consumed, then either
 * extends by what fits (a short extension is an outcome, so the capture always lands) and renews
 * once less than half the TTL remains, or, when final, returns the unused grant. Past `expiresAt`
 * only a final report is accepted, like a late settle (B3).
 */
function decideReport(
  command: Extract<BudgetCommand, { type: "report" }>,
  state: Funded,
  target: Operation | null,
  now: number
): Result<Change, UnPriceBudgetError> {
  const { leaseKey, seq, request } = command
  const lease = target && leaseOf(target, leaseKey)
  // A refused lease was never granted, so it has nothing to report on.
  if (!lease || lease.state.status === "refused") {
    return reject({ code: "LEASE_NOT_FOUND", leaseKey })
  }
  const { last, state: leaseState } = lease
  if (last && last.seq === seq && sameReport(last.request, request)) return Ok(unchanged(lease))
  if (leaseState.status !== "open") {
    return reject({ code: "LEASE_CLOSED", leaseKey, status: leaseState.status })
  }
  const applied = last?.seq ?? 0
  if (seq !== applied + 1) {
    return reject({ code: "LEASE_SEQ_CONFLICT", leaseKey, seq: applied, requested: seq })
  }
  const { captured } = request
  if (captured < lease.captured || captured > lease.granted) {
    return reject({
      code: "LEASE_CAPTURE_OUT_OF_RANGE",
      leaseKey,
      minimum: lease.captured,
      maximum: lease.granted,
      captured,
    })
  }
  if (!request.final && now >= lease.expiresAt) {
    return reject({ code: "LEASE_CLOSED", leaseKey, status: "expired" })
  }

  const balance = balanceOf(state, now)
  const delta = captured - lease.captured
  const crossed = crossings(balance, delta)
  if (request.final) {
    const row: LeaseOperation = {
      ...lease,
      captured,
      last: { seq, request, extended: ZERO, denied: null, crossed },
      state: { status: "closed", closedAt: now },
    }
    return Ok({ rows: [row], row, held: lease.captured - lease.granted, consumed: delta })
  }

  // The extension is judged after the capture it travels with.
  const { ledger } = state
  const afterCapture = balanceOf(
    {
      ...state,
      ledger: { ...ledger, held: ledger.held - delta, usage: consume(ledger.usage, delta) },
    },
    now
  )
  const { config } = state.budget
  const closedAt = config.closesAt !== null && isClosed(config, now) ? config.closesAt : null
  const room = closedAt === null ? roomOf(afterCapture) : ZERO
  const extended = room === null || room >= request.extend ? request.extend : room
  let denied: ExtensionDenial | null = null
  if (extended < request.extend && closedAt !== null) {
    denied = { code: "BUDGET_CLOSED", closedAt }
  } else if (extended < request.extend) {
    const blocked = blockingLimit(afterCapture, request.extend)
    if (!blocked) throw new Error(`lease ${leaseKey} extended short with no blocking limit`)
    denied = { code: "LIMIT_EXCEEDED", blocked }
  }
  const renew = 2 * (lease.expiresAt - now) < lease.ttlMs
  const row: LeaseOperation = {
    ...lease,
    granted: lease.granted + extended,
    captured,
    last: { seq, request, extended, denied, crossed },
    expiresAt: renew ? now + lease.ttlMs : lease.expiresAt,
  }
  return Ok({ rows: [row], row, held: extended - delta, consumed: delta })
}

/** The lease a lease or report addresses; the store found it by the command's lease key. */
function leaseOf(target: Operation, leaseKey: string): LeaseOperation {
  if (target.kind !== "lease" || target.leaseKey !== leaseKey) {
    throw new Error(`target ${target.id} is not the lease ${leaseKey}`)
  }
  return target
}

function decideSettle(
  command: Extract<BudgetCommand, { type: "settle" }>,
  state: Funded,
  target: Operation | null,
  now: number
): Result<Change, UnPriceBudgetError> {
  const hold = holdOf(target, command.holdId, state.ledger)
  if (hold.err) return hold
  const { holdId, amount: actual } = command
  const { amount, state: holdState } = hold.val

  switch (holdState.status) {
    case "settled":
      if (holdState.actual === actual) return Ok(unchanged(hold.val))
      return reject({ code: "HOLD_CLOSED", holdId, status: closedStatus(hold.val) })
    case "released":
      return reject({ code: "HOLD_CLOSED", holdId, status: "released" })
    case "open": {
      // A hard cap holds only if usage never exceeds what was reserved before the work ran.
      if (actual > amount) {
        return reject({ code: "HOLD_AMOUNT_EXCEEDED", holdId, maximum: amount, actual })
      }
      const crossed = crossings(balanceOf(state, now), actual)
      const row: HoldOperation = {
        ...hold.val,
        state: { status: "settled", closedAt: now, actual, crossed },
      }
      return Ok({ rows: [row], row, held: -amount, consumed: actual })
    }
  }
}

function decideRelease(
  command: Extract<BudgetCommand, { type: "release" }>,
  ledger: Ledger,
  target: Operation | null,
  now: number
): Result<Change, UnPriceBudgetError> {
  const hold = holdOf(target, command.holdId, ledger)
  if (hold.err) return hold
  if (command.holdCreatedAt !== undefined && hold.val.createdAt !== command.holdCreatedAt) {
    return reject({ code: "HOLD_NOT_FOUND", holdId: command.holdId })
  }
  switch (hold.val.state.status) {
    case "released":
      return Ok(unchanged(hold.val))
    case "settled":
      return reject({ code: "HOLD_CLOSED", holdId: command.holdId, status: closedStatus(hold.val) })
    case "open": {
      const row: HoldOperation = { ...hold.val, state: { status: "released", closedAt: now } }
      return Ok({ rows: [row], row, held: -hold.val.amount, consumed: ZERO })
    }
  }
}

/** How a settled hold closed: by its caller, or by the alarm at its expiry. */
function closedStatus(hold: HoldOperation): "settled" | "expired" {
  return hold.state.status === "settled" && hold.state.byExpiry ? "expired" : "settled"
}

/**
 * The hold a settle or release addresses. A minted hold whose row is gone was purged after
 * retention: whether it was settled, released, or never closed is no longer known, so it is
 * retired instead of guessed at (a guess would count a retried settle twice).
 */
function holdOf(
  target: Operation | null,
  holdId: string,
  ledger: Ledger
): Result<HoldOperation, UnPriceBudgetError> {
  if (!target) {
    const code = wasMinted(holdId, ledger) ? "HOLD_RETIRED" : "HOLD_NOT_FOUND"
    return reject({ code, holdId })
  }
  if (target.kind !== "hold" || target.id !== holdId) {
    throw new Error(`target ${target.id} is not the row for hold ${holdId}`)
  }
  return Ok(target)
}

/** `h_<n>` in canonical form with 1 <= n <= holdSeq. */
function wasMinted(holdId: string, ledger: Ledger): boolean {
  const n = holdNumber(holdId)
  return holdId === `h_${n}` && n >= 1 && n <= ledger.holdSeq
}

export function holdNumber(holdId: string): number {
  return Number(holdId.slice(2))
}
