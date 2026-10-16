/**
 * Policy (ADR-0006 B1-B3): every rule that accepts or rejects a command. Returns facts or a
 * rejection; folding them is `evolve`'s job.
 */

import { Ok, type Result } from "@unprice/error"
import type { Amount, SignedAmount } from "@unprice/money"
import { type BudgetRecord, HOLD_LAPSE_TTL_MULTIPLIER, MIN_HOLD_TTL_MS, diffConfig } from "./config"
import {
  type Blocked,
  type BlockedRemedy,
  type BudgetBalance,
  type BudgetCommand,
  type BudgetView,
  type Fact,
  type HoldOperation,
  type Ledger,
  type LimitBalance,
  type Operation,
  type UnPriceBudgetError,
  reject,
} from "./model"
import { budgetWindowBounds } from "./windows"

const ZERO = BigInt(0)

type Funded = Readonly<{ budget: BudgetRecord; ledger: Ledger }>

// Reads

/** Pure read at `now` (clamped to `lastAt`). Windows roll virtually; nothing is written. */
export function balanceOf(state: Funded, now: number): BudgetBalance {
  const { ledger } = state
  const at = Math.max(now, ledger.lastAt)
  let remaining: SignedAmount | null = null
  const limits = state.budget.config.limits.map((limit): LimitBalance => {
    const bounds = budgetWindowBounds(limit.window, at)
    const usage = ledger.usage[limit.window]
    const consumed = bounds.start > usage.start ? ZERO : usage.consumed
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
 * Policy for one command against a view that `transition` already swept at a clamped `now`.
 * Zero facts with Ok is a read or an idempotent replay. A rejection writes nothing.
 */
export function decide(
  command: BudgetCommand,
  view: Pick<BudgetView, "budget" | "ledger" | "target">,
  now: number
): Result<Fact[], UnPriceBudgetError> {
  if (command.type === "upsert") return decideUpsert(command, view.budget)
  if (command.type === "sweep") return Ok([])
  const budget = view.budget
  if (!budget) return reject({ code: "BUDGET_NOT_FOUND" })
  const state = { budget, ledger: view.ledger }

  switch (command.type) {
    case "get":
      return Ok([])
    case "authorize":
    case "charge":
    case "record":
      return decideKeyed(command, state, view.target, now)
    case "settle":
      return decideSettle(command, state, view.target, now)
    case "release":
      return decideRelease(command, state.ledger, view.target)
  }
}

function decideUpsert(
  command: Extract<BudgetCommand, { type: "upsert" }>,
  budget: BudgetRecord | null
): Result<Fact[], UnPriceBudgetError> {
  const { key, projectId, unit, config } = command
  if (!budget) {
    const changes = config.limits.map((limit) => ({
      change: "limit.added" as const,
      limitId: limit.id,
    }))
    return Ok([
      { type: "budget.configured", budget: { key, projectId, unit, version: 1, config }, changes },
    ])
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
  if (changes.length === 0) return Ok([])
  return Ok([
    {
      type: "budget.configured",
      budget: { ...budget, version: budget.version + 1, config },
      changes,
    },
  ])
}

function decideKeyed(
  command: Extract<BudgetCommand, { type: "authorize" | "charge" | "record" }>,
  state: Funded,
  target: Operation | null,
  now: number
): Result<Fact[], UnPriceBudgetError> {
  const amount = command.cost.amount
  if (target) {
    if (target.idempotencyKey !== command.idempotencyKey) {
      throw new Error(`target ${target.id} is not the row for key ${command.idempotencyKey}`)
    }
    const kind = command.type === "authorize" ? "hold" : command.type
    if (target.kind === kind && target.requestHash === command.requestHash) return Ok([])
    return reject({ code: "IDEMPOTENCY_CONFLICT", idempotencyKey: command.idempotencyKey })
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

  const balance = balanceOf(state, now)
  if (command.type !== "record") {
    const blocked = blockingLimit(balance, amount)
    if (blocked) return reject({ code: "LIMIT_EXCEEDED", blocked, balance })
  }
  const { idempotencyKey, requestHash } = command
  const crossed = crossings(balance, -amount)

  switch (command.type) {
    case "authorize": {
      const expiresAt = now + ttlMs
      return Ok([
        {
          type: "hold.placed",
          holdId: `h_${state.ledger.holdSeq + 1}`,
          idempotencyKey,
          requestHash,
          amount,
          expiresAt,
          lapsesAt: expiresAt + HOLD_LAPSE_TTL_MULTIPLIER * ttlMs,
          crossed,
        },
      ])
    }
    case "charge":
      return Ok([{ type: "charged", idempotencyKey, requestHash, amount, crossed }])
    case "record":
      return Ok([{ type: "recorded", idempotencyKey, requestHash, amount, crossed }])
  }
}

function decideSettle(
  command: Extract<BudgetCommand, { type: "settle" }>,
  state: Funded,
  target: Operation | null,
  now: number
): Result<Fact[], UnPriceBudgetError> {
  const hold = holdOf(target, command.holdId, state.ledger)
  if (hold.err) return hold
  const { holdId } = command
  const actual = command.cost.amount
  const { amount, state: holdState } = hold.val

  switch (holdState.status) {
    case "settled":
      if (holdState.actual === actual) return Ok([])
      return reject({ code: "HOLD_CLOSED", holdId, status: "settled" })
    case "released":
      return reject({ code: "HOLD_CLOSED", holdId, status: "released" })
    case "lapsed":
      // The lapse already returned the hold, so all of `actual` is consumed as late usage.
      return Ok([
        settled(state, now, { holdId, actual, covered: ZERO, released: ZERO, late: true }),
      ])
    case "open": {
      const covered = actual < amount ? actual : amount
      const released = amount - covered
      return Ok([settled(state, now, { holdId, actual, covered, released, late: false })])
    }
  }
}

function settled(
  state: Funded,
  now: number,
  settle: Readonly<{
    holdId: string
    actual: Amount
    covered: Amount
    released: Amount
    late: boolean
  }>
): Fact {
  const crossed = crossings(balanceOf(state, now), settle.covered + settle.released - settle.actual)
  return { type: "hold.settled", ...settle, overrun: settle.actual - settle.covered, crossed }
}

function decideRelease(
  command: Extract<BudgetCommand, { type: "release" }>,
  ledger: Ledger,
  target: Operation | null
): Result<Fact[], UnPriceBudgetError> {
  const hold = holdOf(target, command.holdId, ledger)
  if (hold.err) return hold
  const { holdId } = command

  switch (hold.val.state.status) {
    case "released":
      return Ok([])
    case "settled":
      return reject({ code: "HOLD_CLOSED", holdId, status: "settled" })
    case "lapsed":
      return Ok([{ type: "hold.released", holdId, released: ZERO }])
    case "open":
      return Ok([{ type: "hold.released", holdId, released: hold.val.amount }])
  }
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

function holdNumber(holdId: string): number {
  return Number(holdId.slice(2))
}

/** Open holds past `lapsesAt`, in lapse order. */
export function lapseFacts(operations: Iterable<Operation>, now: number): Fact[] {
  const due: HoldOperation[] = []
  for (const operation of operations) {
    if (
      operation.kind === "hold" &&
      operation.state.status === "open" &&
      operation.lapsesAt <= now
    ) {
      due.push(operation)
    }
  }
  due.sort((a, b) => a.lapsesAt - b.lapsesAt || holdNumber(a.id) - holdNumber(b.id))
  return due.map((hold) => ({ type: "hold.lapsed", holdId: hold.id, released: hold.amount }))
}
