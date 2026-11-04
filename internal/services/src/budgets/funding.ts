/**
 * Funding (ADR-0008 D10). A postpaid budget never touches the wallet: its sealed statements become
 * receivables at billing. A prepaid budget admits a priced charge or hold only while the wallet
 * reservation of each statement key it bills can cover it. The core has no I/O, so it refuses with
 * FUNDING_REQUIRED and writes nothing; the caller asks for a reserve intent (`fund`), runs it
 * against the wallet, applies the result (`applyFunding`), and sends the command again. A seal
 * that leaves a key with nothing open turns its reservation into a close intent. Every intent is
 * persisted before the wallet call and replayed with the same `seq` after a crash.
 */

import { Ok, type Result } from "@unprice/error"
import type { Amount, SignedAmount } from "@unprice/money"
import {
  DEFAULT_MAX_OUTSTANDING_AMOUNT,
  computeInitialReservation,
  computeSyncGrowRefillAmount,
} from "../wallet/reservation-sizing"
import type { BudgetRecord } from "./config"
import type { Change } from "./decide"
import { isPerpetual } from "./meter"
import {
  type BudgetCommand,
  type BudgetView,
  type Funding,
  type FundingCapture,
  type FundingNeed,
  type FundingWork,
  type Statement,
  type UnPriceBudgetError,
  reject,
} from "./model"
import { byPeriodId } from "./statements"

const ZERO = BigInt(0)
const MONEY_PREFIX = "money:"

/** The payer whose wallet funds the budget's priced usage; null for a postpaid budget. */
export function prepaidPayer(budget: BudgetRecord | null): string | null {
  const funding = budget?.config.pricing?.funding
  return funding?.mode === "prepaid" ? funding.customerId : null
}

/** What a command does to the wallet reservations it read. */
export type FundingStep = Readonly<{
  /** Reservations created or changed; the store upserts exactly these. */
  rows: readonly Funding[]
  /** Intents pending after the command, for a funding command or a seal to answer with. */
  work: readonly FundingWork[]
  /** An `applyFunding` for an intent already applied. */
  replayed: boolean
}>

type FundingInput = Readonly<{
  command: BudgetCommand
  view: Pick<BudgetView, "funding" | "statements">
  /** The budget after the command. */
  budget: BudgetRecord | null
  change: Change
  /** What open holds and leases held before the command, on the amount. */
  heldBefore: Amount
  now: number
}>

/**
 * The reservations a command moves: every statement write moves its key's `consumed`; a prepaid
 * charge or hold must fit what its keys can still lend; `fund`, `applyFunding`, and a seal step the
 * protocol. A shortfall rejects the command and writes nothing.
 */
export function decideFunding(input: FundingInput): Result<FundingStep, UnPriceBudgetError> {
  const { command, view, budget, change, heldBefore, now } = input
  const rows = new Map(view.funding.map((row) => [row.statementKey, row]))
  const prior = byPeriodId(view.statements)

  const shortfalls = admissionShortfalls(input, rows)
  if (shortfalls.length > 0) return reject({ code: "FUNDING_REQUIRED", needs: shortfalls })

  const written = new Map<string, Funding>()
  for (const [statementKey, delta] of statementDeltas(change, prior)) {
    const row = rows.get(statementKey)
    if (!row || delta === ZERO) continue
    written.set(statementKey, { ...row, consumed: row.consumed + delta })
  }

  const unit = budget?.unit ?? ""
  const step = (next: Funding | null, current: Funding | null, replayed = false): FundingStep => {
    const pending = next ?? current
    return {
      rows: next ? [next] : [],
      work: pending?.pending ? [workOf(pending, unit)] : [],
      replayed,
    }
  }

  switch (command.type) {
    case "fund": {
      const row = rows.get(command.statementKey) ?? null
      return Ok(step(decideFund(command, row, budget, view.statements, heldBefore, now), row))
    }
    case "applyFunding":
      return decideApplied(command, rows, view.statements, now, step)
    case "sealStatements": {
      const row = rows.get(command.statementKey) ?? null
      if (!row) return Ok(step(null, null))
      const after = [...byPeriodId([...view.statements, ...(change.statements ?? [])]).values()]
      const closed = closing(row, keyStatements(after, row.statementKey), now)
      return Ok(step(closed === row ? null : closed, row))
    }
    default:
      return Ok({ rows: [...written.values()], work: [], replayed: false })
  }
}

/** How much each statement key's statements moved, by key. */
/**
 * What each key's billed statements moved. A free (trial) statement bills nothing and its close
 * captures nothing, so it never consumes the key's allocation.
 */
function statementDeltas(change: Change, prior: Map<string, Statement>): Map<string, Amount> {
  const deltas = new Map<string, Amount>()
  for (const statement of change.statements ?? []) {
    if (statement.free) continue
    const before = prior.get(statement.periodId)?.amount ?? ZERO
    const key = statement.statementKey
    deltas.set(key, (deltas.get(key) ?? ZERO) + statement.amount - before)
  }
  return deltas
}

/**
 * What an accepted charge or new hold needs from each statement key it bills: what the key's
 * statements consumed plus what the command holds. A hold is not tied to one key, so every hold
 * counts against every key it prices on, and a reservation never lends one allocation twice.
 */
function requiredByKey(input: FundingInput): Map<string, Amount> {
  const { command, change, view } = input
  if (change.rows.length === 0) return new Map()
  const statements = byPeriodId(view.statements)
  const deltas = statementDeltas(change, statements)
  let keys: string[] = []
  if (command.type === "charge") keys = [...deltas.keys()]
  if (command.type === "authorize" && change.row?.kind === "hold") {
    const hold = change.row
    keys = (hold.estimate?.features ?? []).flatMap((feature) => {
      const statement = statements.get(feature.periodId)
      if (!statement) throw new Error(`hold ${hold.id} priced on ${feature.periodId}, not read`)
      return statement.free ? [] : [statement.statementKey]
    })
  }
  const held = change.held.amount
  return new Map(keys.map((key) => [key, (deltas.get(key) ?? ZERO) + held]))
}

/**
 * The keys a prepaid charge or hold cannot fund: what it needs from a key must fit the key's
 * allocation less what the key consumed and less everything held.
 */
function admissionShortfalls(input: FundingInput, rows: Map<string, Funding>): FundingNeed[] {
  if (!prepaidPayer(input.budget)) return []
  const needs: FundingNeed[] = []
  for (const [statementKey, required] of requiredByKey(input)) {
    if (required <= ZERO) continue
    const available = availableOf(rows.get(statementKey), input.heldBefore)
    if (required > available) needs.push({ statementKey, required, available })
  }
  return needs
}

/** What a key can still lend; a key with no reservation, or a closed one, lends nothing. */
function availableOf(row: Funding | undefined, held: Amount): SignedAmount {
  if (!row || row.state !== "open") return -held
  return row.allocated - row.consumed - held
}

/**
 * A reserve intent for a key that cannot cover `required`, or null. A pending intent is answered
 * as it was persisted, so a replay repeats its `seq`, amount, and time. A key needs an open
 * statement to reserve for: the reservation spans its statements' periods.
 */
function decideFund(
  command: Extract<BudgetCommand, { type: "fund" }>,
  row: Funding | null,
  budget: BudgetRecord | null,
  statements: readonly Statement[],
  heldBefore: Amount,
  now: number
): Funding | null {
  const payer = prepaidPayer(budget)
  if (!payer || row?.pending || row?.state === "closed") return null
  const own = keyStatements(statements, command.statementKey)
  if (!own.some((statement) => statement.state === "open")) return null
  const funding = row ?? {
    statementKey: command.statementKey,
    customerId: payer,
    reservationId: null,
    allocated: ZERO,
    consumed: own.reduce((sum, statement) => (statement.free ? sum : sum + statement.amount), ZERO),
    seq: 0,
    pending: null,
    state: "open" as const,
    closedAt: null,
    captured: ZERO,
  }
  const available = funding.allocated - funding.consumed - heldBefore
  if (available >= command.required) return null
  return {
    ...funding,
    pending: {
      kind: "reserve",
      seq: funding.seq + 1,
      amount: reserveAmount(command.required, available),
      at: now,
      periodStart: Math.min(...own.map((statement) => statement.start)),
      periodEnd: Math.max(...own.map((statement) => statement.end)),
    },
  }
}

function decideApplied(
  command: Extract<BudgetCommand, { type: "applyFunding" }>,
  rows: Map<string, Funding>,
  statements: readonly Statement[],
  now: number,
  step: (next: Funding | null, current: Funding | null, replayed?: boolean) => FundingStep
): Result<FundingStep, UnPriceBudgetError> {
  const { statementKey, seq, result } = command
  const row = rows.get(statementKey)
  if (!row) return reject({ code: "FUNDING_SEQ_CONFLICT", statementKey, seq: 0, requested: seq })
  const { pending } = row
  if (pending?.seq !== seq) {
    if (seq <= row.seq) return Ok(step(null, row, true))
    return reject({ code: "FUNDING_SEQ_CONFLICT", statementKey, seq: row.seq, requested: seq })
  }
  if (pending.kind === "close") {
    if (result.kind !== "closed") throw new Error(`close ${seq} of ${statementKey} got a reserve`)
    const captured = pending.captures.reduce((sum, capture) => sum + capture.amount, ZERO)
    const closed: Funding = {
      ...row,
      seq,
      pending: null,
      state: "closed",
      closedAt: now,
      captured,
    }
    return Ok(step(closed, row))
  }
  if (result.kind !== "reserved") throw new Error(`reserve ${seq} of ${statementKey} got a close`)
  const { reservationId, granted } = result
  if (granted < ZERO || granted > pending.amount) {
    throw new Error(`reserve ${seq} of ${statementKey} granted ${granted} of ${pending.amount}`)
  }
  if (row.reservationId !== null && row.reservationId !== reservationId) {
    throw new Error(`reserve ${seq} of ${statementKey} answered for ${reservationId}`)
  }
  const reserved: Funding = {
    ...row,
    reservationId,
    allocated: row.allocated + granted,
    seq,
    pending: null,
  }
  // A reserve that lands after its key sealed closes at once.
  return Ok(step(closing(reserved, keyStatements(statements, statementKey), now), row))
}

/**
 * Once every statement of the key is sealed, the reservation closes: a reservation the wallet
 * never opened closes here; an opened one gets a close intent capturing each statement's amount,
 * in period id order, up to the allocation. A free statement (a trial) captures nothing, so its
 * share is released. Usage past the allocation stays on the statements as a receivable. Unchanged
 * while anything is open on the key or an intent is pending.
 */
function closing(row: Funding, own: readonly Statement[], now: number): Funding {
  if (row.state === "closed" || row.pending) return row
  if (own.length === 0 || own.some((statement) => statement.state === "open")) return row
  if (row.reservationId === null) {
    return { ...row, state: "closed", closedAt: now, captured: ZERO }
  }
  let left = row.allocated
  const captures: FundingCapture[] = []
  const billed = own.filter((statement) => !statement.free)
  for (const statement of billed.sort((a, b) => (a.periodId < b.periodId ? -1 : 1))) {
    const amount = statement.amount < left ? statement.amount : left
    if (amount <= ZERO) continue
    captures.push({ periodId: statement.periodId, amount })
    left -= amount
  }
  return { ...row, pending: { kind: "close", seq: row.seq + 1, captures } }
}

/** The billing statements with this key. */
function keyStatements(statements: readonly Statement[], statementKey: string): Statement[] {
  return statements.filter((s) => s.statementKey === statementKey && !isPerpetual(s))
}

function workOf(row: Funding, unit: string): FundingWork {
  if (!row.pending) throw new Error(`statement ${row.statementKey} has no pending intent`)
  if (!unit.startsWith(MONEY_PREFIX)) throw new Error(`a prepaid budget priced in ${unit}`)
  return {
    statementKey: row.statementKey,
    customerId: row.customerId,
    currency: unit.slice(MONEY_PREFIX.length),
    reservationId: row.reservationId,
    intent: row.pending,
  }
}

/**
 * What a reserve asks the wallet for: the shortfall, grown to the runway an entitlement window
 * would reserve for this cost (`reservation-sizing`), so a busy payer refills about once per ten
 * minutes rather than once per event.
 */
export function reserveAmount(required: Amount, available: SignedAmount): Amount {
  const shortfall = required - available
  const safe = BigInt(Number.MAX_SAFE_INTEGER)
  if (required > safe || shortfall > safe) return shortfall
  const cost = Number(required)
  const { targetReservationAmount } = computeInitialReservation({
    pricePerEventAmount: cost,
    currentEventCostAmount: cost,
  })
  const grown = BigInt(
    computeSyncGrowRefillAmount({
      remainingAmount: available > ZERO ? Number(available) : 0,
      currentEventCostAmount: cost,
      targetReservationAmount,
      maxOutstandingAmount: DEFAULT_MAX_OUTSTANDING_AMOUNT,
    })
  )
  return grown > shortfall ? grown : shortfall
}

/**
 * Violations of funding conservation; empty when the transition may commit.
 * 1. A reservation's `allocated` and `seq` never shrink, and a pending intent is `seq + 1`.
 * 2. A closed reservation never changes again and has nothing pending.
 * 3. `consumed` moves by exactly what the key's written statements moved; a new reservation
 *    starts at the sum of the key's statement amounts.
 * 4. A close captures only positive amounts of statements billing does not waive, in total no
 *    more than the allocation and those statements.
 * 5. A prepaid charge or hold never leaves a key it bills lending more than it was allocated.
 */
export function fundingViolations(params: {
  input: FundingInput
  heldAfter: Amount
  rows: readonly Funding[]
}): string[] {
  const { input, heldAfter, rows } = params
  const violations: string[] = []
  const prior = new Map(input.view.funding.map((row) => [row.statementKey, row]))
  const deltas = statementDeltas(input.change, byPeriodId(input.view.statements))
  for (const row of rows) {
    const at = `funding ${row.statementKey}`
    const before = prior.get(row.statementKey)
    if (row.allocated < (before?.allocated ?? ZERO) || row.seq < (before?.seq ?? 0)) {
      violations.push(`${at} shrank`)
    }
    if (row.pending && row.pending.seq !== row.seq + 1) {
      violations.push(`${at} intent ${row.pending.seq} does not follow ${row.seq}`)
    }
    if (before?.state === "closed") violations.push(`${at} changed after it closed`)
    if (row.state === "closed" && (row.pending || row.closedAt === null)) {
      violations.push(`${at} closed with an intent pending`)
    }
    const own = keyStatements(input.view.statements, row.statementKey)
    const expected = before
      ? before.consumed + (deltas.get(row.statementKey) ?? ZERO)
      : own.reduce((sum, statement) => sum + statement.amount, ZERO)
    if (row.consumed !== expected) {
      violations.push(`${at} consumed ${row.consumed}, expected ${expected}`)
    }
    if (row.pending?.kind === "close") {
      const captured = row.pending.captures.reduce((sum, capture) => sum + capture.amount, ZERO)
      const billed = own
        .filter((statement) => !statement.free)
        .reduce((sum, statement) => sum + statement.amount, ZERO)
      const free = new Set(own.filter((s) => s.free).map((s) => s.periodId))
      if (row.pending.captures.some((capture) => free.has(capture.periodId))) {
        violations.push(`${at} captures a free statement`)
      }
      if (row.pending.captures.some((capture) => capture.amount <= ZERO)) {
        violations.push(`${at} captures a non-positive amount`)
      }
      if (captured > row.allocated || captured > billed) {
        violations.push(`${at} captures ${captured} of ${row.allocated} allocated`)
      }
    }
  }
  if (prepaidPayer(input.budget)) {
    const written = new Map(rows.map((row) => [row.statementKey, row]))
    for (const [statementKey, required] of requiredByKey(input)) {
      if (required <= ZERO) continue
      const row = written.get(statementKey) ?? prior.get(statementKey)
      const exposure = (row?.consumed ?? ZERO) + heldAfter
      if (!row || exposure > row.allocated) {
        violations.push(`funding ${statementKey} lent ${exposure} of ${row?.allocated ?? ZERO}`)
      }
    }
  }
  return violations
}
