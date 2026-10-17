/**
 * Policy (ADR-0006 B1-B3): every rule that accepts or rejects a command. Returns the change it
 * makes or a rejection; applying the change to the ledger is `transition`'s job.
 */

import { Ok, type Result } from "@unprice/error"
import type { Amount, SignedAmount } from "@unprice/money"
import {
  type BudgetRecord,
  type ConfigChange,
  HOLD_LAPSE_TTL_MULTIPLIER,
  MIN_HOLD_TTL_MS,
  OPERATION_RETENTION_MS,
  RECORD_ACCEPT_WINDOW_MS,
  RECORD_FUTURE_SKEW_MS,
  diffConfig,
  isClosed,
} from "./config"
import {
  type Blocked,
  type BlockedRemedy,
  type BudgetBalance,
  type BudgetCommand,
  type BudgetView,
  type HoldOperation,
  type Ledger,
  type LimitBalance,
  type Operation,
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

/**
 * Among hard limits that `amount` would push below zero, the one with the latest `resetsAt`
 * (never resets last); ties go to config order. That limit decides when the request can pass.
 */
function blockingLimit(balance: BudgetBalance, amount: Amount): Blocked | null {
  let blocking: LimitBalance | null = null
  for (const limit of balance.limits) {
    if (limit.enforce !== "hard" || limit.remaining - amount >= ZERO) continue
    if (blocking === null || resetsLater(limit.resetsAt, blocking.resetsAt)) blocking = limit
  }
  if (!blocking) return null

  let remedy: BlockedRemedy = "raise_limit"
  if (amount <= blocking.amount) {
    if (blocking.held > ZERO && blocking.remaining + blocking.held - amount >= ZERO) {
      remedy = "release_holds"
    } else if (blocking.window !== "never") {
      remedy = "wait_for_reset"
    }
  }
  return {
    limitId: blocking.id,
    window: blocking.window,
    remaining: blocking.remaining,
    held: blocking.held,
    resetsAt: blocking.resetsAt,
    remedy,
  }
}

function resetsLater(a: number | null, b: number | null): boolean {
  if (b === null) return false
  return a === null || a > b
}

/** Limits (hard and soft) whose remaining moves from >= 0 to < 0 when it changes by `delta`. */
function crossings(balance: BudgetBalance, delta: SignedAmount): string[] {
  return balance.limits
    .filter((limit) => limit.remaining >= ZERO && limit.remaining + delta < ZERO)
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
 * Policy for one command against a view that `transition` already swept at a clamped `now`.
 * A rejection writes nothing.
 */
export function decide(
  command: BudgetCommand,
  view: Pick<BudgetView, "budget" | "ledger" | "target">,
  now: number
): Result<Change, UnPriceBudgetError> {
  if (command.type === "upsert") return decideUpsert(command, view.budget)
  if (command.type === "sweep") return Ok(unchanged(null))
  const budget = view.budget
  if (!budget) return reject({ code: "BUDGET_NOT_FOUND" })
  const state = { budget, ledger: view.ledger }

  switch (command.type) {
    case "get":
      return Ok(unchanged(null))
    case "authorize":
    case "charge":
    case "record":
      return decideKeyed(command, state, view.target, now)
    case "settle":
      return decideSettle(command, state, view.target, now)
    case "release":
      return decideRelease(command, state.ledger, view.target, now)
  }
}

function decideUpsert(
  command: Extract<BudgetCommand, { type: "upsert" }>,
  budget: BudgetRecord | null
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
  const changes = diffConfig(budget.config, config)
  if (changes.length === 0) return Ok(unchanged(null))
  const updated = { ...budget, version: budget.version + 1, config }
  return Ok({ ...unchanged(null), configured: { budget: updated, changes } })
}

/** A keyed command repeats its row when the verb, the amount, and (for a hold) the TTL match. */
function sameRequest(
  row: Operation,
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
    if (target.idempotencyKey !== idempotencyKey) {
      throw new Error(`target ${target.id} is not the row for key ${idempotencyKey}`)
    }
    if (sameRequest(target, command)) return Ok(unchanged(target))
    return reject({ code: "IDEMPOTENCY_CONFLICT", idempotencyKey })
  }

  let ttlMs = 0
  if (command.type === "authorize") {
    const { holds } = state.budget.config
    ttlMs = command.ttlMs ?? holds.defaultTtlMs
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_HOLD_TTL_MS || ttlMs > holds.maxTtlMs) {
      return reject({
        code: "INVALID_TTL",
        ttlMs,
        minTtlMs: MIN_HOLD_TTL_MS,
        maxTtlMs: holds.maxTtlMs,
      })
    }
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
  const grace = command.type === "record" ? OPERATION_RETENTION_MS : 0
  if (config.closesAt !== null && isClosed(config, now, grace)) {
    return reject({ code: "BUDGET_CLOSED", closedAt: config.closesAt })
  }

  const balance = balanceOf(state, now)
  if (command.type !== "record") {
    const blocked = blockingLimit(balance, amount)
    if (blocked) return reject({ code: "LIMIT_EXCEEDED", blocked, balance })
  }

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
      lapsesAt: expiresAt + HOLD_LAPSE_TTL_MULTIPLIER * ttlMs,
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
    crossed: crossings(balance, -amount),
  }
  return Ok({ rows: [row], row, held: ZERO, consumed: amount })
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
      return reject({ code: "HOLD_CLOSED", holdId, status: "settled" })
    case "released":
      return reject({ code: "HOLD_CLOSED", holdId, status: "released" })
    case "lapsed":
      // The lapse already returned the hold, so all of `actual` is consumed as late usage.
      return Ok(settle(state, hold.val, now, { actual, covered: ZERO, released: ZERO, late: true }))
    case "open": {
      const covered = actual < amount ? actual : amount
      const released = amount - covered
      return Ok(settle(state, hold.val, now, { actual, covered, released, late: false }))
    }
  }
}

function settle(
  state: Funded,
  hold: HoldOperation,
  now: number,
  settled: Readonly<{ actual: Amount; covered: Amount; released: Amount; late: boolean }>
): Change {
  const { actual, covered, released } = settled
  const crossed = crossings(balanceOf(state, now), covered + released - actual)
  const row: HoldOperation = {
    ...hold,
    state: { status: "settled", closedAt: now, ...settled, overrun: actual - covered, crossed },
  }
  return { rows: [row], row, held: -(covered + released), consumed: actual }
}

function decideRelease(
  command: Extract<BudgetCommand, { type: "release" }>,
  ledger: Ledger,
  target: Operation | null,
  now: number
): Result<Change, UnPriceBudgetError> {
  const hold = holdOf(target, command.holdId, ledger)
  if (hold.err) return hold
  const status = hold.val.state.status
  if (status === "released") return Ok(unchanged(hold.val))
  if (status === "settled") {
    return reject({ code: "HOLD_CLOSED", holdId: command.holdId, status: "settled" })
  }
  // A lapsed hold already returned its amount; releasing it only closes it.
  const released = status === "open" ? hold.val.amount : ZERO
  const row: HoldOperation = { ...hold.val, state: { status: "released", closedAt: now, released } }
  return Ok({ rows: [row], row, held: -released, consumed: ZERO })
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

/** Open holds past `lapsesAt`, lapsed at `now`: the sweep every command runs before it decides. */
export function lapse(holds: Iterable<Operation>, now: number): Change {
  const rows: HoldOperation[] = []
  let held = ZERO
  for (const hold of holds) {
    if (hold.kind !== "hold" || hold.state.status !== "open" || hold.lapsesAt > now) continue
    rows.push({ ...hold, state: { status: "lapsed", lapsedAt: now } })
    held -= hold.amount
  }
  return { rows, row: null, held, consumed: ZERO }
}
