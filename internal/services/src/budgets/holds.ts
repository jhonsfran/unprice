/** Budget holds rules. */

import { Ok, type Result } from "@unprice/error"
import { balanceOf, crossings } from "./balance"
import { type Change, type Context, measure, movedBy, negated, repeats, unchanged } from "./decide"
import { exposureOf } from "./ledger"
import type { Metered } from "./meter"
import type {
  BudgetCommand,
  HoldOperation,
  Ledger,
  Operation,
  ReservationOperation,
  Statement,
  UsageOrEvent,
} from "./model"
import { type UnPriceBudgetError, reject } from "./rejections"
import { byPeriodId } from "./statements"
import { NO_USAGE, type Usage, addUsage, exceededMeasure, measured } from "./usage"

/**
 * Closes every expired reservation into consumption: a timer cannot prove the work or the process
 * stopped, so a hold counts everything it permitted and a lease everything it was granted. An
 * estimate is consumed as its event priced where the positions stand, which the estimate bounds.
 * Held capacity becomes consumption in the current window and returns when that window rolls. A
 * late settle that repeats the hold's own request replays; another is refused.
 */
export function decideSweep(
  state: Context,
  expired: readonly ReservationOperation[],
  now: number
): Change {
  const balance = balanceOf(state, now)
  let consumed = NO_USAGE
  let released = NO_USAGE
  // Statements as the expiries before this one left them, so two holds can bill one statement.
  const statements = byPeriodId(state.statements)
  const written = new Map<string, Statement>()
  const rows = expired.map((row): ReservationOperation => {
    if (row.state.status !== "open" || row.expiresAt > now) {
      throw new Error(`${row.kind} ${row.id} is not open past its expiry`)
    }
    if (row.kind === "lease") {
      const exposure = exposureOf(row)
      consumed = addUsage(consumed, exposure)
      released = addUsage(released, exposure)
      return { ...row, captured: row.granted, state: { status: "expired", closedAt: now } }
    }
    const expiry = expiryOf({ ...state, statements: [...statements.values()] }, row)
    const crossed = crossings(balance, expiry.actual, consumed)
    consumed = addUsage(consumed, expiry.actual)
    released = addUsage(released, row.reserved)
    for (const statement of expiry.statements) {
      statements.set(statement.periodId, statement)
      written.set(statement.periodId, statement)
    }
    const settled = { status: "settled", closedAt: now, actual: expiry.actual, crossed } as const
    return { ...closing(row), state: { ...settled, byExpiry: true, ...expiry.billing } }
  })
  return {
    rows,
    row: null,
    held: negated(released),
    consumed,
    statements: [...written.values()],
  }
}

type Expiry = Readonly<{
  actual: Usage
  statements: readonly Statement[]
  billing: Pick<Extract<HoldOperation["state"], { status: "settled" }>, "priced" | "unbilled">
}>

/**
 * An expired hold without an estimate consumes `reserved`. An estimate is billed like a settle of
 * its event; when no statement can take it, or it prices above the hold, the ledger consumes
 * `reserved` and marks it unbilled. `state.statements` are as the earlier expiries left them.
 */
function expiryOf(state: Context, hold: HoldOperation): Expiry {
  const { estimate, reserved } = hold
  if (!estimate) return { actual: reserved, statements: [], billing: {} }
  const event = { slug: estimate.slug, properties: estimate.properties }
  const settled = holdActual(hold, { event }, state)
  if (settled.err) {
    return { actual: reserved, statements: [], billing: { unbilled: { reason: settled.err.code } } }
  }
  const { usage, metered } = settled.val
  if (!metered) throw new Error(`hold ${hold.id} billed its estimate without metering it`)
  return { actual: usage, statements: metered.statements, billing: { priced: metered.priced } }
}

/**
 * What a hold consumes for `input`. The actual prices at the authorization time, so a price change
 * between authorize and settle never changes what one call costs (B3), and where the positions
 * stand now, which the estimate bounded from any position. A hard cap holds only if usage never
 * exceeds, on any measure, what was reserved before the work ran.
 */
function holdActual(
  hold: HoldOperation,
  input: UsageOrEvent,
  state: Context
): Result<{ usage: Usage; metered: Metered | null }, UnPriceBudgetError> {
  const metering = measure(input, state, hold.createdAt, false)
  if (metering.err) return metering
  const exceeded = exceededMeasure(metering.val.usage, hold.reserved)
  if (!exceeded) return metering
  return reject({
    code: "HOLD_AMOUNT_EXCEEDED",
    holdId: hold.id,
    measure: exceeded,
    maximum: measured(hold.reserved, exceeded),
    actual: measured(metering.val.usage, exceeded),
  })
}

/** A closed hold keeps its estimate's event for retries, not the lines it reserved on. */
function closing(hold: HoldOperation): HoldOperation {
  const { estimate } = hold
  if (!estimate) return hold
  const features = estimate.features.map((feature) => ({ ...feature, lines: [] }))
  return { ...hold, estimate: { ...estimate, features } }
}

export function decideSettle(
  command: Extract<BudgetCommand, { type: "settle" }>,
  state: Context,
  target: Operation | null,
  now: number
): Result<Change, UnPriceBudgetError> {
  const hold = holdOf(target, command.holdId, state.ledger)
  if (hold.err) return hold
  const { holdId } = command
  const { reserved, state: holdState } = hold.val

  const input: UsageOrEvent = command.event ? { event: command.event } : { usage: command.actual }
  switch (holdState.status) {
    case "settled": {
      // The caller's settle replays its own request; one closed at expiry, the hold's.
      const same = holdState.byExpiry
        ? repeats(input, hold.val.estimate, reserved)
        : repeats(input, holdState.priced, holdState.actual)
      if (same) return Ok(unchanged(hold.val))
      return reject({ code: "HOLD_CLOSED", holdId, status: closedStatus(hold.val) })
    }
    case "released":
      return reject({ code: "HOLD_CLOSED", holdId, status: "released" })
    case "open": {
      const settled = holdActual(hold.val, input, state)
      if (settled.err) return settled
      const { usage: actual, metered } = settled.val
      const crossed = crossings(balanceOf(state, now), actual)
      const priced = metered && { priced: metered.priced }
      const row: HoldOperation = {
        ...closing(hold.val),
        state: { status: "settled", closedAt: now, actual, crossed, ...priced },
      }
      return Ok({
        rows: [row],
        row,
        held: negated(reserved),
        consumed: actual,
        ...movedBy(metered),
      })
    }
  }
}

export function decideRelease(
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
      const row: HoldOperation = {
        ...closing(hold.val),
        state: { status: "released", closedAt: now },
      }
      return Ok({ rows: [row], row, held: negated(hold.val.reserved), consumed: NO_USAGE })
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

export function decideAuthorize(
  command: Extract<BudgetCommand, { type: "authorize" }>,
  state: Context,
  usage: Usage,
  metered: Metered | null,
  ttlMs: number,
  now: number
): Result<Change, UnPriceBudgetError> {
  const expiresAt = now + ttlMs
  const hold: HoldOperation = {
    kind: "hold",
    id: `h_${state.ledger.holdSeq + 1}`,
    idempotencyKey: command.idempotencyKey,
    reserved: usage,
    ttlMs: command.ttlMs ?? null,
    createdAt: now,
    expiresAt,
    state: { status: "open" },
    // The estimate moves no position: only the settle's actual does.
    ...(metered && { estimate: metered.priced }),
  }
  return Ok({ rows: [hold], row: hold, held: usage, consumed: NO_USAGE })
}
