/**
 * Policy (ADR-0006 B1-B3): every rule that accepts or rejects a command. Returns the change it
 * makes or a rejection; applying the change to the ledger is `transition`'s job.
 */

import { Ok, type Result } from "@unprice/error"
import type { Amount, SignedAmount } from "@unprice/money"
import {
  type BudgetRecord,
  type ConfigChange,
  MAX_RETAINED_ANCHORED_WINDOWS,
  MIN_HOLD_TTL_MS,
  OPERATION_RETENTION_MS,
  RECORD_ACCEPT_WINDOW_MS,
  RECORD_FUTURE_SKEW_MS,
  diffConfig,
  isClosed,
  loosening,
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

function blockingLimit(balance: BudgetBalance, amount: Amount): Blocked | null {
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
  view: Pick<BudgetView, "budget" | "ledger" | "target" | "expiredHolds">,
  now: number
): Result<Change, UnPriceBudgetError> {
  if (command.type === "upsert") return decideUpsert(command, view.budget, view.ledger, now)
  const budget = view.budget
  if (command.type === "sweep") {
    return Ok(
      budget
        ? decideSweep({ budget, ledger: view.ledger }, view.expiredHolds, now)
        : unchanged(null)
    )
  }
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
  const changes = diffConfig(budget.config, config)
  if (changes.length === 0) return Ok(unchanged(null))
  const loosened = command.mayLoosen ? null : loosening(budget.config, config)
  if (loosened) return reject({ code: "LOOSENING_FORBIDDEN", change: loosened })
  const updated = { ...budget, version: budget.version + 1, config }
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
 * Settles every expired hold at its full amount: a timer cannot prove the work stopped, so the
 * hold counts everything it permitted. Held capacity becomes consumption in the current window and
 * returns when that window rolls. A late settle of the same amount replays; another is refused.
 */
function decideSweep(state: Funded, holds: readonly HoldOperation[], now: number): Change {
  const balance = balanceOf(state, now)
  let consumed = ZERO
  const rows = holds.map((hold): HoldOperation => {
    if (hold.state.status !== "open" || hold.expiresAt > now) {
      throw new Error(`hold ${hold.id} is not an open hold past its expiry`)
    }
    const crossed = crossings(balance, hold.amount, consumed)
    consumed += hold.amount
    return {
      ...hold,
      state: { status: "settled", closedAt: now, actual: hold.amount, crossed, byExpiry: true },
    }
  })
  return { rows, row: null, held: -consumed, consumed }
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
  // Recorded work already ran: refusing it would lose the count, not the spend.
  const blocked = command.type === "record" ? null : blockingLimit(balance, amount)
  if (blocked) return reject({ code: "LIMIT_EXCEEDED", blocked, balance })

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
