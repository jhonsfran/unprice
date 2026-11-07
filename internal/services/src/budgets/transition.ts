/**
 * Pure budget core (ADR-0006 B1-B3, B7). No clock, no I/O.
 *
 * `decide` owns every policy rule and returns the change a command makes, or a rejection.
 * `transition` rolls ended windows, decides, applies the change to the ledger, and checks
 * conservation. A store keeps what it returns in one transaction: the ledger (one row, the
 * authoritative balance), one row per operation (open hold, closed tombstone, idempotency
 * record), and the window history.
 */

import { type BudgetPricing, CARD_REFRESH_MS } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { CardRows } from "../pricing"
import {
  type BudgetOperations,
  type BudgetRecord,
  type ConfigChange,
  WINDOW_HISTORY_PERIODS,
  deletableAt,
  isClosed,
} from "./config"
import { type Change, balanceOf, decide, holdNumber, repricesBudget, upsertPricing } from "./decide"
import { decideFunding, fundingViolations, prepaidPayer } from "./funding"
import { type RowStep, checkTransition } from "./invariants"
import { alarmAt, consume, dueAt, restartAmounts, rollUsage, trackLimits } from "./ledger"
import { cardIdsOf, featuresOf } from "./meter"
import {
  type BudgetBalance,
  type BudgetCommand,
  type BudgetOutcome,
  type BudgetReply,
  type BudgetView,
  type Funding,
  type FundingWork,
  type LeaseOperation,
  type LeaseView,
  type Ledger,
  type Operation,
  type ReservationOperation,
  type Statement,
  type UnPriceBudgetError,
  type WindowPeriod,
  reject,
} from "./model"
import {
  type PositionWrite,
  byPeriodId,
  movedPositions,
  statementViolations,
  statementsAnswer,
} from "./statements"
import { addUsage, subtractUsage } from "./usage"
import { type WindowId, windowIdOf } from "./windows"

const ZERO = BigInt(0)

/** The reads a store answers inside its transaction. Rows come back as domain types. */
export type BudgetReader = {
  readBudget(): BudgetRecord | null
  readLedger(): Ledger
  readOperation(id: string): Operation | null
  readOperationByKey(idempotencyKey: string): Operation | null
  /** The lease with this key, or null when it never existed or was purged. */
  readLease(leaseKey: string): LeaseOperation | null
  /** Up to `limit` stored periods of each window id, newest first. */
  readHistory(windowIds: readonly WindowId[], limit: number): WindowPeriod[]
  /**
   * Up to `limit` open holds and leases with `expiresAt <= now`, by `expiresAt`, then holds before
   * leases, holds by number.
   */
  readExpired(now: number, limit: number): ReservationOperation[]
  /** Whether any hold or lease is open, expired or not. */
  hasOpenReservations(): boolean
  /** When each of these cards was last cached; a card the store has not cached is absent. */
  cardsRefreshedAt(cardIds: readonly string[]): Record<string, number>
  /** The cached rate cards with these ids; a card the store has not cached is absent. */
  readCards(cardIds: readonly string[]): Record<string, CardRows>
  /** The statements with these period ids. */
  readStatements(periodIds: readonly string[]): Statement[]
  /** Statements of these features that are open or overlap [from, to). */
  readFeatureStatements(features: readonly string[], from: number, to: number): Statement[]
  /** Every statement with this key, whatever its state. */
  readKeyStatements(statementKey: string): Statement[]
  /** Every open and sealed statement. */
  readUnfinishedStatements(): Statement[]
  /** The wallet reservations of these statement keys; a key without one is absent. */
  readFunding(statementKeys: readonly string[]): Funding[]
}

/** The most expired reservations one sweep closes; the alarm comes back at once for the rest. */
export const EXPIRED_PER_SWEEP = 256

/**
 * Loads the addressed operation, the history a `get` returns, the expired reservations a `sweep`
 * closes at the clock `transition` will clamp to, and the cards and statements a command that
 * prices or addresses statements needs.
 */
export function loadView(
  reader: BudgetReader,
  command: BudgetCommand,
  clockMs: number
): BudgetView {
  const ledger = reader.readLedger()
  const budget = reader.readBudget()
  const now = Math.max(clockMs, ledger.lastAt)
  const target = targetOf(reader, command)
  const pricing = pricingOf(command, budget)
  const expired =
    command.type === "sweep" && budget ? reader.readExpired(now, EXPIRED_PER_SWEEP) : []
  const prices = pricing !== undefined && willPrice(command, budget, target, expired, now)
  // A pricing or unit change waits for open reservations (ADR-0008 D1).
  const repriced = command.type === "upsert" && budget !== null && repricesBudget(command, budget)
  const statements = statementsOf(
    reader,
    command,
    prices ? pricing : undefined,
    target,
    expired,
    now
  )
  return {
    funding: budget ? reader.readFunding(fundingKeysOf(command, budget, statements)) : [],
    budget,
    ledger,
    target,
    history:
      command.type === "get" && budget
        ? reader.readHistory(limitedWindows(budget), WINDOW_HISTORY_PERIODS)
        : [],
    expired,
    cards: pricing && prices ? reader.readCards(cardIdsOf(pricing)) : {},
    // The alarm's sweep cannot refresh cards. An expiry prices at its hold's createdAt, when the
    // cards were fresh, and rows effective then were published before it (ADR-0008 D2 notice).
    staleCards:
      pricing && prices && command.type !== "sweep"
        ? staleCardsOf(reader, cardIdsOf(pricing), now)
        : [],
    reservationsOpen: repriced && reader.hasOpenReservations(),
    // Several expiries may read the same statement.
    statements: [...byPeriodId(statements).values()],
  }
}

function staleCardsOf(reader: BudgetReader, cardIds: readonly string[], now: number): string[] {
  const refreshedAt = reader.cardsRefreshedAt(cardIds)
  return cardIds.filter((cardId) => {
    const at = Object.hasOwn(refreshedAt, cardId) ? refreshedAt[cardId] : undefined
    return at === undefined || now - at >= CARD_REFRESH_MS
  })
}

/**
 * The statement keys whose wallet reservations the command reads: the one a funding command or a
 * seal addresses, and for a prepaid budget the keys of the statements an event reads.
 */
function fundingKeysOf(
  command: BudgetCommand,
  budget: BudgetRecord,
  statements: readonly Statement[]
): string[] {
  switch (command.type) {
    case "fund":
    case "applyFunding":
    case "sealStatements":
      return [command.statementKey]
  }
  if (!prepaidPayer(budget)) return []
  return [...new Set(statements.map((statement) => statement.statementKey))]
}

/** The pricing the command runs under: an upsert's, else the budget's or the one it creates. */
function pricingOf(command: BudgetCommand, budget: BudgetRecord | null): BudgetPricing | undefined {
  if (command.type === "upsert") return upsertPricing(command, budget)
  if (budget) return budget.config.pricing
  return "ifMissing" in command ? command.ifMissing?.config.pricing : undefined
}

/**
 * Whether the command reaches the cards: a create or an upsert that changes pricing checks them, an
 * event is priced, an expired estimate is billed. A keyed replay and a settle of a closed hold
 * answer from their row.
 */
function willPrice(
  command: BudgetCommand,
  budget: BudgetRecord | null,
  target: Operation | null,
  expired: readonly ReservationOperation[],
  now: number
): boolean {
  if (budget === null) return true
  if (command.type === "upsert") return repricesBudget(command, budget)
  const live = target !== null && !isPastRetention(target, now)
  switch (command.type) {
    case "authorize":
    case "charge":
    case "record":
      return command.event !== undefined && !live
    case "settle":
      return (
        command.event !== undefined && target?.kind === "hold" && target.state.status === "open"
      )
    case "sweep":
      return expired.some((row) => row.kind === "hold" && row.estimate !== undefined)
    default:
      return false
  }
}

/**
 * The statements a command reads. An event reads its features' open statements and those covering
 * the time it prices at: a record's `occurredAt`, a settle's (or an expiry's) hold `createdAt`,
 * else the clock. `pricing` is undefined when the command will not price.
 */
function statementsOf(
  reader: BudgetReader,
  command: BudgetCommand,
  pricing: BudgetPricing | undefined,
  target: Operation | null,
  expired: readonly ReservationOperation[],
  now: number
): Statement[] {
  const eventStatements = (slug: string, from: number, to: number) => {
    const features = pricing ? featuresOf(pricing, slug).map((feature) => feature.slug) : []
    return features.length === 0 ? [] : reader.readFeatureStatements(features, from, to)
  }
  switch (command.type) {
    case "authorize":
    case "charge":
    case "record":
    case "settle": {
      const { event } = command
      if (!event) return []
      let at = now
      if (command.type === "record") at = command.occurredAt
      if (command.type === "settle") {
        if (target?.kind !== "hold") return []
        at = target.createdAt
      }
      return eventStatements(event.slug, at, at + 1)
    }
    case "sweep": {
      // One read per event slug, over the span of its holds' times.
      const spans = new Map<string, { from: number; to: number }>()
      for (const row of expired) {
        if (row.kind !== "hold" || !row.estimate) continue
        const span = spans.get(row.estimate.slug)
        spans.set(row.estimate.slug, {
          from: Math.min(span?.from ?? row.createdAt, row.createdAt),
          to: Math.max(span?.to ?? row.createdAt + 1, row.createdAt + 1),
        })
      }
      return [...spans].flatMap(([slug, { from, to }]) => eventStatements(slug, from, to))
    }
    case "registerStatements": {
      const { statements } = command
      return [
        ...reader.readStatements(statements.map((statement) => statement.periodId)),
        ...statements.flatMap(({ featureSlug, start, end }) =>
          reader.readFeatureStatements([featureSlug], start, end)
        ),
      ]
    }
    // A seal and a funding command read the whole key: a reservation closes once none is open.
    case "sealStatements":
    case "fund":
    case "applyFunding":
      return reader.readKeyStatements(command.statementKey)
    case "completeStatements":
      return reader.readStatements(command.periodIds)
    case "statements":
      return reader.readUnfinishedStatements()
    default:
      return []
  }
}

/** Window ids the budget's limits use, once each, in limit order. */
function limitedWindows(budget: BudgetRecord): WindowId[] {
  return [...new Set(budget.config.limits.map((limit) => windowIdOf(limit)))]
}

function targetOf(reader: BudgetReader, command: BudgetCommand): Operation | null {
  switch (command.type) {
    case "authorize":
    case "charge":
    case "record":
      return reader.readOperationByKey(command.idempotencyKey)
    case "settle":
    case "release":
      return reader.readOperation(command.holdId)
    case "lease":
    case "report":
      return reader.readLease(command.leaseKey)
    default:
      return null
  }
}

/**
 * What to write, and what the command answers. Almost every rejection is an Err that writes
 * nothing; a refused lease is the one rejection that is written, so its key replays the refusal.
 */
export type BudgetTransition = Readonly<{
  /** The clamped clock; the written ledger's `lastAt`. */
  now: number
  /** False for a read or a replay: the store writes nothing. */
  write: boolean
  /** The new config to write, or null when it did not change. */
  budget: BudgetRecord | null
  ledger: Ledger
  /** A row past its retention whose key this command reuses; the store deletes it first. */
  purged: readonly Operation[]
  /** Rows created or changed; the store upserts exactly these. */
  operations: readonly Operation[]
  /** Ended periods to add to the window history. */
  periods: readonly WindowPeriod[]
  /** Anchored schedules whose inactive current period ended. */
  retiredWindows: readonly WindowId[]
  /** Statements created or changed; the store upserts exactly these. */
  statements: readonly Statement[]
  /** The positions those statements moved; a store that keeps positions apart writes these. */
  positions: readonly PositionWrite[]
  /** Wallet reservations created or changed; the store upserts exactly these. */
  funding: readonly Funding[]
  /**
   * Earliest `alarmAt` among the written rows, and a new config's `deletableAt`; the store only
   * ever lowers its alarm to it. A window boundary needs no wake: a counter keeps its period's
   * start, so the next command rolls it the same however late it comes.
   */
  wakeAt: number | null
}> &
  BudgetReply

/**
 * Clamps the clock, rolls ended windows, decides, applies and checks the change.
 * A rejection writes nothing. An invariant failure throws and must abort the transaction.
 */
export function transition(params: {
  view: BudgetView
  command: BudgetCommand
  clockMs: number
}): Result<BudgetTransition, UnPriceBudgetError> {
  const { view, command, clockMs } = params
  if (!Number.isSafeInteger(clockMs)) throw new Error(`clock ${clockMs} is not an integer`)
  const now = Math.max(clockMs, view.ledger.lastAt)

  // A closed row answers only until its retention ends, however late the alarm purges it.
  const pastRetention = view.target && isPastRetention(view.target, now) ? view.target : null
  const live = pastRetention ? null : view.target
  const limits = view.budget?.config.limits ?? []
  const rolled = rollUsage(view.ledger.usage, now, limits)
  const rolledLedger: Ledger = { ...view.ledger, usage: rolled.usage }
  if (view.staleCards.length > 0) return reject({ code: "CARDS_STALE", cardIds: view.staleCards })

  const decided = decide(
    command,
    {
      budget: view.budget,
      ledger: rolledLedger,
      target: live,
      expired: view.expired,
      cards: view.cards,
      statements: view.statements,
      reservationsOpen: view.reservationsOpen,
    },
    now
  )
  if (decided.err) return Err(decided.err)
  const change = decided.val

  const budget = change.configured?.budget ?? view.budget
  // A new unit restarts every amount counter; quantities carry over (ADR-0008 D1).
  const unitChanged = view.budget !== null && budget !== null && budget.unit !== view.budget.unit
  const counters = unitChanged ? restartAmounts(rolledLedger.usage) : rolledLedger.usage
  const usage = change.configured
    ? trackLimits(counters, change.configured.budget.config.limits, now)
    : counters
  const ledger: Ledger = {
    lastAt: now,
    holdSeq: change.rows.reduce(
      (seq, row) => (row.kind === "hold" ? Math.max(seq, holdNumber(row.id)) : seq),
      rolledLedger.holdSeq
    ),
    held: addUsage(rolledLedger.held, change.held),
    usage: consume(usage, change.consumed),
    operations: countCall(rolledLedger.operations, command, change),
  }
  const operations = change.rows
  const { periods } = rolled
  // A row changes from the addressed one, or from an expired reservation a sweep closes; else it
  // is new.
  const priors = new Map<string, Operation>(view.expired.map((row) => [row.id, row]))
  if (live) priors.set(live.id, live)

  const fundingInput = {
    command,
    view,
    budget,
    change,
    heldBefore: rolledLedger.held.amount,
    now,
  }
  const funded = decideFunding(fundingInput)
  if (funded.err) return Err(funded.err)
  const funding = funded.val.rows

  const statements = change.statements ?? []
  const priorStatements = byPeriodId(view.statements)
  const steps = change.rows.map((row): RowStep => [priors.get(row.id), row])
  const violations = [
    ...checkTransition({
      before: view.ledger,
      after: ledger,
      limits,
      resultingLimits: budget?.config.limits ?? [],
      steps,
      periods,
      unitChanged,
    }),
    ...statementViolations({
      steps: statements.map((s) => [priorStatements.get(s.periodId), s] as const),
      rows: steps,
    }),
    ...fundingViolations({ input: fundingInput, heldAfter: ledger.held.amount, rows: funding }),
  ]
  if (violations.length > 0) {
    throw new Error(`budget transition breaks invariants: ${violations.join("; ")}`)
  }

  let wakeAt = change.configured ? deletableAt(change.configured.budget.config) : null
  for (const operation of operations) {
    const due = alarmAt(operation)
    if (wakeAt === null || due < wakeAt) wakeAt = due
  }
  // A sweep always moves the budget's clock to now, so the purge after it never runs ahead of a
  // later command's clamped clock.
  const write =
    budget !== null &&
    (operations.length > 0 ||
      statements.length > 0 ||
      funding.length > 0 ||
      periods.length > 0 ||
      rolled.retired.length > 0 ||
      change.configured !== undefined ||
      command.type === "sweep")

  return Ok({
    now,
    write,
    budget: change.configured?.budget ?? null,
    ledger,
    purged: pastRetention && change.rows.length > 0 ? [pastRetention] : [],
    operations,
    periods,
    retiredWindows: rolled.retired,
    statements,
    positions: statements.flatMap((s) => movedPositions(priorStatements.get(s.periodId), s)),
    funding,
    wakeAt,
    ...replyOf(command, {
      budget,
      ledger,
      row: change.row,
      replayed: change.rows.length === 0,
      changes: change.configured?.changes ?? [],
      created: change.configured !== undefined && command.type !== "upsert",
      history: [...periods, ...view.history],
      statements: [...byPeriodId([...view.statements, ...statements]).values()],
      work: funded.val.work,
      fundingReplayed: funded.val.replayed,
      now,
    }),
  })
}

/**
 * Counts a caller's command that changed the budget. A replay, an upsert that changed nothing, a
 * refused lease (written only so its key stays refused), and the alarm's sweep (which closes
 * expired reservations) are not counted.
 */
function countCall(
  operations: BudgetOperations,
  command: BudgetCommand,
  change: Pick<Change, "rows" | "configured" | "row">
): BudgetOperations {
  switch (command.type) {
    case "get":
    case "sweep":
    case "statements":
    case "registerStatements":
    case "sealStatements":
    case "completeStatements":
    case "fund":
    case "applyFunding":
      return operations
  }
  if (change.rows.length === 0 && change.configured === undefined) return operations
  if (refusalOf(change.row)) return operations
  return { ...operations, [command.type]: operations[command.type] + 1 }
}

/** Past its retention. An open hold or lease has none until it is closed. */
function isPastRetention(row: Operation, now: number): boolean {
  const due = dueAt(row)
  return due !== null && due <= now
}

/** What a refused lease said blocked it; null for any other row. */
function refusalOf(row: Operation | null) {
  return row?.kind === "lease" && row.state.status === "refused" ? row.state.blocked : null
}

type OutcomeParams = Readonly<{
  budget: BudgetRecord | null
  ledger: Ledger
  row: Operation | null
  replayed: boolean
  changes: readonly ConfigChange[]
  /** A keyed verb created the budget it ran against. */
  created: boolean
  /** This transition's periods, then the stored ones. */
  history: readonly WindowPeriod[]
  /** The statements the command read, with its writes applied. */
  statements: readonly Statement[]
  /** Funding intents pending after the command, for a funding command or a seal. */
  work: readonly FundingWork[]
  /** An `applyFunding` for an intent already applied. */
  fundingReplayed: boolean
  now: number
}>

/** A refused lease, first or replayed, answers like any denial: LIMIT_EXCEEDED. */
function replyOf(command: BudgetCommand, params: OutcomeParams): BudgetReply {
  const { budget, ledger, row, now } = params
  const blocked = refusalOf(row)
  if (!blocked) return { ok: true, outcome: outcomeOf(command, params) }
  if (!budget) throw new Error("lease refused without a budget")
  const balance = balanceOf({ budget, ledger }, now)
  return { ok: false, rejection: { code: "LIMIT_EXCEEDED", blocked, balance } }
}

function outcomeOf(command: BudgetCommand, params: OutcomeParams): BudgetOutcome {
  const { budget, ledger, row, replayed, now } = params
  if (command.type === "sweep") return { type: "sweep" }
  if (!budget) throw new Error(`${command.type} accepted without a budget`)
  const balance = balanceOf({ budget, ledger }, now)
  const created = params.created ? snapshotOf(budget, ledger, balance, now) : null

  switch (command.type) {
    case "upsert":
      return {
        type: "upsert",
        changes: params.changes,
        budget: snapshotOf(budget, ledger, balance, now),
      }
    case "get":
      return {
        type: "get",
        budget: snapshotOf(budget, ledger, balance, now),
        history: historyOf(budget, params.history),
      }
    case "statements":
    case "registerStatements":
    case "completeStatements":
      return {
        type: command.type,
        statements: statementsAnswer(command, params.statements, now),
      }
    case "sealStatements":
      return {
        type: command.type,
        statements: statementsAnswer(command, params.statements, now),
        funding: params.work,
      }
    case "fund":
      return { type: "fund", funding: params.work }
    case "applyFunding":
      return { type: "applyFunding", funding: params.work, replayed: params.fundingReplayed }
    case "authorize": {
      if (row?.kind !== "hold") throw new Error("authorize produced no hold row")
      const { id: holdId, reserved, expiresAt } = row
      return { type: "authorize", holdId, reserved, expiresAt, replayed, balance, created }
    }
    case "charge":
    case "record": {
      if (row?.kind !== command.type)
        throw new Error(`${command.type} produced no ${command.type} row`)
      return {
        type: command.type,
        usage: row.usage,
        crossed: row.crossed,
        replayed,
        balance,
        created,
      }
    }
    case "release": {
      if (row?.kind !== "hold" || row.state.status !== "released") {
        throw new Error(`release of ${command.holdId} produced no released row`)
      }
      return { type: "release", holdId: row.id, released: row.reserved, replayed, balance }
    }
    case "settle": {
      if (row?.kind !== "hold" || row.state.status !== "settled") {
        throw new Error(`settle of ${command.holdId} produced no settled row`)
      }
      const { actual, closedAt, crossed } = row.state
      return {
        type: "settle",
        holdId: row.id,
        actual,
        released: subtractUsage(row.reserved, actual),
        expired: closedAt >= row.expiresAt,
        crossed,
        replayed,
        balance,
      }
    }
    case "lease": {
      if (row?.kind !== "lease") throw new Error("lease produced no lease row")
      return {
        type: "lease",
        lease: leaseView(row),
        terms: termsOf(budget),
        replayed,
        balance,
        created,
      }
    }
    case "report": {
      if (row?.kind !== "lease" || !row.last) {
        throw new Error(`report on ${command.leaseKey} produced no reported lease`)
      }
      const { request, extended, denied, crossed } = row.last
      return {
        type: "report",
        lease: leaseView(row),
        terms: termsOf(budget),
        extension: { requested: request.final ? ZERO : request.extend, granted: extended, denied },
        released: request.final ? row.granted - row.captured : ZERO,
        crossed,
        replayed,
        balance,
      }
    }
  }
}

function leaseView(lease: LeaseOperation): LeaseView {
  const { leaseKey, granted, captured, expiresAt, last, state } = lease
  if (state.status === "refused") throw new Error(`lease ${leaseKey} was refused`)
  return { leaseKey, seq: last?.seq ?? 0, granted, captured, expiresAt, status: state.status }
}

function termsOf(budget: BudgetRecord) {
  return { holds: budget.config.holds, closesAt: budget.config.closesAt }
}

function snapshotOf(budget: BudgetRecord, ledger: Ledger, balance: BudgetBalance, now: number) {
  const { key, unit, version, config } = budget
  const closed = isClosed(config, now)
  return { key, unit, version, ...config, closed, balance, operations: ledger.operations }
}

/** Up to WINDOW_HISTORY_PERIODS periods per limited window, newest first. */
function historyOf(budget: BudgetRecord, periods: readonly WindowPeriod[]): WindowPeriod[] {
  return limitedWindows(budget).flatMap((id) =>
    periods.filter((period) => period.windowId === id).slice(0, WINDOW_HISTORY_PERIODS)
  )
}
