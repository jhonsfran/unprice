/**
 * Billing statements (ADR-0007, ADR-0008 D4, D6): registration, seal, and completion, what each
 * answers, and the conservation every transition that writes statements must keep.
 */

import { Ok, type Result } from "@unprice/error"
import type { Amount } from "@unprice/money"
import type { RowStep } from "./invariants"
import { emptyStatement, isPerpetual, sumCosts } from "./meter"
import {
  type BudgetCommand,
  type PricedEvent,
  type Statement,
  type StatementCommandType,
  type StatementRegistration,
  type UnPriceBudgetError,
  reject,
} from "./model"

const ZERO = BigInt(0)

type StatementCommand = Extract<BudgetCommand, { type: StatementCommandType }>

/** Whether billing waives both, or neither: a period's waiver is fixed when it is registered. */
function sameWaiver(statement: Statement, registration: StatementRegistration): boolean {
  return statement.free === (registration.free ?? false)
}

function sameRegistration(statement: Statement, registration: StatementRegistration): boolean {
  return (
    sameWaiver(statement, registration) &&
    statement.statementKey === registration.statementKey &&
    statement.featureSlug === registration.featureSlug &&
    statement.start === registration.start &&
    statement.end === registration.end
  )
}

/**
 * Whether `registration` ends an open statement early: billing cut its period short (a plan change
 * or a cancel ends the phase mid-cycle), and no event the statement counted happened at or after
 * the new end, so every line still falls inside it.
 */
function shortens(statement: Statement, registration: StatementRegistration): boolean {
  return (
    statement.state === "open" &&
    sameWaiver(statement, registration) &&
    statement.statementKey === registration.statementKey &&
    statement.featureSlug === registration.featureSlug &&
    statement.start === registration.start &&
    registration.end < statement.end &&
    (statement.lastEventAt === null || statement.lastEventAt < registration.end)
  )
}

/**
 * Where a statement ends when billing registers `requested` as its end: never at or before an event
 * it counted, so usage recorded before billing cut the period short stays in it.
 */
function endKeepingEvents(statement: Statement, requested: number): number {
  return statement.lastEventAt === null ? requested : Math.max(requested, statement.lastEventAt + 1)
}

/**
 * Whether a stored statement is what `registration` registers: the same fields, except that its
 * end may stand past the registered one to keep the events it counted before billing cut it short,
 * and its start may stand later to follow a predecessor's tail (`afterTail`).
 */
function registers(statement: Statement, registration: StatementRegistration): boolean {
  return (
    sameWaiver(statement, registration) &&
    statement.statementKey === registration.statementKey &&
    statement.featureSlug === registration.featureSlug &&
    statement.start >= registration.start &&
    statement.start < registration.end &&
    (statement.end === registration.end ||
      (statement.end > registration.end &&
        statement.end === endKeepingEvents(statement, registration.end)))
  )
}

/**
 * The statement of the same feature whose end was held past its registered end by an event it
 * counted (an extended tail), when it alone overlaps `registration` and only at its start.
 */
function tailBefore(
  registration: StatementRegistration,
  overlapping: readonly Statement[]
): Statement | null {
  const [other] = overlapping
  if (overlapping.length !== 1 || !other) return null
  const extended =
    other.lastEventAt !== null &&
    other.end === other.lastEventAt + 1 &&
    other.start < registration.start &&
    other.end < registration.end
  return extended ? other : null
}

/**
 * The statements to create or cut short. A period id registered with the same fields replays; an
 * earlier end shortens an open statement to it, or to just past its last event when an event
 * already landed past it (`endKeepingEvents`); a stored statement that already took either cut
 * replays; anything else conflicts. A new statement must not overlap another of its feature, except
 * the tail such a cut kept: it then starts where that statement ends. `known` holds every stored
 * statement with one of the period ids, and every one of each feature that is open or overlaps.
 */
export function decideRegister(
  registrations: readonly StatementRegistration[],
  known: readonly Statement[],
  now: number
): Result<Statement[], UnPriceBudgetError> {
  const byId = byPeriodId(known)
  const created: Statement[] = []
  for (const registration of registrations) {
    const { periodId, start, end } = registration
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
      throw new Error(`statement ${periodId} spans [${start}, ${end})`)
    }
    const existing = byId.get(periodId)
    if (existing) {
      if (registers(existing, registration)) continue
      const cut = { ...registration, end: endKeepingEvents(existing, end) }
      if (!shortens(existing, cut)) return reject({ code: "STATEMENT_CONFLICT", periodId })
      const shortened = { ...existing, end: cut.end }
      byId.set(periodId, shortened)
      created.push(shortened)
      continue
    }
    // "#" names the budget's own perpetual statements; billing never registers into them.
    if (periodId.startsWith("#") || registration.statementKey.startsWith("#")) {
      return reject({ code: "STATEMENT_CONFLICT", periodId })
    }
    const overlapping = [...byId.values()].filter(
      (other) =>
        other.featureSlug === registration.featureSlug &&
        !isPerpetual(other) &&
        other.start < end &&
        start < other.end
    )
    const tail = tailBefore(registration, overlapping)
    const [overlap] = overlapping
    if (overlap && !tail) {
      return reject({ code: "STATEMENT_OVERLAP", periodId, overlaps: overlap.periodId })
    }
    const statement = emptyStatement(
      tail ? { ...registration, start: tail.end } : registration,
      now
    )
    byId.set(periodId, statement)
    created.push(statement)
  }
  return Ok(created)
}

type SealCommand = Extract<BudgetCommand, { type: "sealStatements" }>

/** Statements by period id; a later one with the same id wins. */
export function byPeriodId(statements: readonly Statement[]): Map<string, Statement> {
  return new Map(statements.map((statement) => [statement.periodId, statement]))
}

/**
 * The seal's cutoff: statements ending by it seal. `at`, but never past the budget's clock, so a
 * period that has not ended cannot be sealed early.
 */
export function sealCutoff(command: SealCommand, now: number): number {
  return Math.min(command.at, now)
}

/**
 * Seals the open statements with this key that ended by the seal's time. Sealing again changes
 * nothing.
 */
export function decideSeal(
  command: SealCommand,
  known: readonly Statement[],
  now: number
): Statement[] {
  return known
    .filter((statement) => isSealable(statement, command, now) && statement.state === "open")
    .map((statement) => ({ ...statement, state: "sealed", sealedAt: now }))
}

function isSealable(statement: Statement, command: SealCommand, now: number): boolean {
  return (
    statement.statementKey === command.statementKey &&
    statement.end <= sealCutoff(command, now) &&
    !isPerpetual(statement)
  )
}

/** Sealed -> completed. Completing again changes nothing; an open statement is refused. */
export function decideComplete(
  periodIds: readonly string[],
  known: readonly Statement[],
  now: number
): Result<Statement[], UnPriceBudgetError> {
  const byId = byPeriodId(known)
  const completed: Statement[] = []
  for (const periodId of new Set(periodIds)) {
    const statement = byId.get(periodId)
    if (!statement) return reject({ code: "STATEMENT_NOT_FOUND", periodId })
    if (statement.state === "open") return reject({ code: "STATEMENT_NOT_SEALED", periodId })
    if (statement.state === "sealed") {
      completed.push({ ...statement, state: "completed", completedAt: now })
    }
  }
  return Ok(completed)
}

/** What a statement command answers, from the statements it read with its writes applied. */
export function statementsAnswer(
  command: StatementCommand,
  statements: readonly Statement[],
  now: number
) {
  const byId = byPeriodId(statements)
  const named = (periodIds: readonly string[]) =>
    [...new Set(periodIds)].flatMap((periodId) => byId.get(periodId) ?? [])
  switch (command.type) {
    case "registerStatements":
      return named(command.statements.map((registration) => registration.periodId))
    case "sealStatements":
      return statements.filter(
        (statement) => isSealable(statement, command, now) && statement.state === "sealed"
      )
    case "completeStatements":
      return named(command.periodIds)
    case "statements":
      return [...statements]
  }
}

/** A pricing position a write moved, at its new value. */
export type PositionWrite = Readonly<{ periodId: string; positionKey: string; value: Amount }>

/** The positions `statement` holds at another value than `prior` did, or that `prior` lacked. */
export function movedPositions(
  prior: Statement | undefined,
  statement: Statement
): PositionWrite[] {
  const before = prior?.positions ?? {}
  return Object.entries(statement.positions).flatMap(([positionKey, value]) =>
    Object.hasOwn(before, positionKey) && before[positionKey] === value
      ? []
      : [{ periodId: statement.periodId, positionKey, value }]
  )
}

/** One statement moving from what it was (undefined when created) to what it became. */
type StatementStep = readonly [prior: Statement | undefined, statement: Statement]

const NEXT_STATE: Record<Statement["state"] | "new", readonly Statement["state"][]> = {
  new: ["open"],
  open: ["open", "sealed"],
  sealed: ["completed"],
  completed: [],
}

/** An event a row step priced into statements, and what the ledger consumed for it. */
type Billed = Readonly<{ priced: PricedEvent; consumed: Amount }>

/**
 * What a row step billed: a new charge or record with its event, or a hold closing with its priced
 * actual (a settle) or its priced estimate (an expiry).
 */
function billedBy([prior, row]: RowStep): Billed | null {
  if ((row.kind === "charge" || row.kind === "record") && !prior && row.priced) {
    return { priced: row.priced, consumed: row.usage.amount }
  }
  const closing = row.kind === "hold" && prior?.kind === "hold" && prior.state.status === "open"
  if (closing && row.state.status === "settled" && row.state.priced) {
    return { priced: row.state.priced, consumed: row.state.actual.amount }
  }
  return null
}

/**
 * Violations of statement conservation; empty when the transition may commit.
 * 1. A statement keeps its identity and moves only open -> sealed -> completed. Only an open one
 *    may end earlier, and never at or before an event it counted.
 * 2. Its amount, quantity, cost, and events grow by exactly what the rows billed to it, and its
 *    positions move exactly as the billed lines say, in row order. A sealed statement never
 *    changes.
 * 3. Every billed feature landed in a written statement, and each billed event's features sum to
 *    what the ledger consumed for it. A priced budget consumes only events, so its statements sum
 *    to the ledger's lifetime amount less the expired estimates marked `unbilled`.
 * 4. An expired hold with an estimate is either billed or marked `unbilled`, never both.
 */
export function statementViolations(params: {
  steps: readonly StatementStep[]
  rows: readonly RowStep[]
}): string[] {
  const violations: string[] = []
  const billed = params.rows.flatMap((step) => billedBy(step) ?? [])
  const features = billed.flatMap(({ priced }) => priced.features)
  for (const [prior, statement] of params.steps) {
    const at = `statement ${statement.periodId}`
    const routed = features.filter((feature) => feature.periodId === statement.periodId)
    if (prior && !sameIdentity(prior, statement)) violations.push(`${at} changed identity`)
    if (!NEXT_STATE[prior?.state ?? "new"].includes(statement.state)) {
      violations.push(`${at} moved from ${prior?.state ?? "nothing"} to ${statement.state}`)
    }
    if (routed.length > 0 && prior && prior.state !== "open") {
      violations.push(`${at} is ${prior.state} but took usage`)
    }
    const expected = {
      amount: routed.reduce((sum, feature) => sum + feature.amount, prior?.amount ?? ZERO),
      quantity: routed.reduce(
        (sum, feature) => sum + feature.meterQuantity,
        prior?.quantity ?? ZERO
      ),
      events: (prior?.events ?? 0) + routed.length,
      cost: sumCosts([prior?.cost ?? null, ...routed.map((feature) => feature.cost)]),
    }
    for (const field of ["amount", "quantity", "events", "cost"] as const) {
      if (statement[field] !== expected[field]) {
        violations.push(`${at} ${field} is ${statement[field]}, expected ${expected[field]}`)
      }
    }
    const positions: Record<string, Amount> = { ...prior?.positions }
    for (const line of routed.flatMap((feature) => feature.lines)) {
      if ((positions[line.positionKey] ?? ZERO) !== line.before) {
        violations.push(`${at} priced ${line.positionKey} from ${line.before}, not its position`)
      }
      positions[line.positionKey] = line.after
    }
    if (!samePositions(positions, statement.positions)) violations.push(`${at} moved positions`)
  }
  const written = new Set(params.steps.map(([, statement]) => statement.periodId))
  for (const feature of features) {
    if (!written.has(feature.periodId)) {
      violations.push(`${feature.featureSlug} routed to ${feature.periodId}, which was not written`)
    }
  }
  for (const { priced, consumed } of billed) {
    const total = priced.features.reduce((sum, feature) => sum + feature.amount, ZERO)
    if (total !== consumed)
      violations.push(`${priced.slug} billed ${total} but consumed ${consumed}`)
  }
  for (const [, row] of params.rows) {
    if (row.kind !== "hold" || row.state.status !== "settled" || !row.state.byExpiry) continue
    if (row.estimate && !row.state.priced === !row.state.unbilled) {
      violations.push(`expired hold ${row.id} must be billed or marked unbilled`)
    }
  }
  return violations
}

/** The same statement, or an open one cut short before any event it counted. */
function sameIdentity(a: Statement, b: Statement): boolean {
  if (a.periodId !== b.periodId) return false
  return sameRegistration(a, b) || (b.state === "open" && shortens(a, b))
}

function samePositions(a: Readonly<Record<string, Amount>>, b: Readonly<Record<string, Amount>>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every((key) => (a[key] ?? ZERO) === (b[key] ?? ZERO))
}
