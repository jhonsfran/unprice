/**
 * Policy (ADR-0006 B1-B3): every rule that accepts or rejects a command. Returns the change it
 * makes or a rejection; applying the change to the ledger is `transition`'s job.
 */

import type { BudgetPricing } from "@unprice/db/validators"
import { Ok, type Result } from "@unprice/error"
import type { Amount, SignedAmount } from "@unprice/money"
import { type RateCards, validateCard } from "../pricing"
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
  samePricing,
} from "./config"
import { consume, exposureOf } from "./ledger"
import { type Metered, cardsOf, meterEvent, sameEvent } from "./meter"
import {
  type Blocked,
  type BlockedRemedy,
  type BudgetBalance,
  type BudgetCommand,
  type BudgetEvent,
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
  type Statement,
  type UnPriceBudgetError,
  type UsageOrEvent,
  reject,
} from "./model"
import { byPeriodId, decideComplete, decideRegister, decideSeal } from "./statements"
import {
  NO_USAGE,
  type Usage,
  addUsage,
  amountUsage,
  exceededMeasure,
  measured,
  sameMeasure,
  sameUsage,
  subtractUsage,
  usageOf,
} from "./usage"
import { windowBounds, windowIdOf } from "./windows"

const ZERO = BigInt(0)

type Funded = Readonly<{ budget: BudgetRecord; ledger: Ledger }>

/** What a verb decides against: the funded budget plus the cards and statements it prices on. */
type Context = Funded & Pick<BudgetView, "cards" | "statements">

// Reads

/**
 * Pure read at `now` (clamped to `lastAt`). Windows roll virtually; nothing is written. Each limit
 * reads its own measure of the counter and of what is held.
 */
export function balanceOf(state: Funded, now: number): BudgetBalance {
  const { ledger } = state
  const at = Math.max(now, ledger.lastAt)
  let remaining: SignedAmount | null = null
  const limits = state.budget.config.limits.map((limit): LimitBalance => {
    const { measure } = limit
    const bounds = windowBounds(limit, at)
    const usage = ledger.usage[windowIdOf(limit)]
    const consumed = !usage || bounds.start > usage.start ? ZERO : measured(usage.consumed, measure)
    const held = measured(ledger.held, measure)
    const limitRemaining = limit.amount - consumed - held
    const counts = limit.enforce === "hard" && measure.type === "amount"
    if (counts && (remaining === null || limitRemaining < remaining)) remaining = limitRemaining
    return {
      id: limit.id,
      window: limit.window,
      enforce: limit.enforce,
      measure,
      amount: limit.amount,
      consumed,
      held,
      remaining: limitRemaining,
      resetsAt: bounds.end,
    }
  })
  return { remaining, held: ledger.held, limits, asOf: at }
}

/** The balance a lease sees: quantity limits ignore leases, which reserve the amount only. */
function amountLimitsOf(balance: BudgetBalance): BudgetBalance {
  return { ...balance, limits: balance.limits.filter((limit) => limit.measure.type === "amount") }
}

/**
 * What would deny a request for `request` at this balance; null when it fits every hard limit that
 * gates it, on that limit's measure.
 */
export function blockingLimit(balance: BudgetBalance, request: Usage): Blocked | null {
  const need = (limit: LimitBalance) => measured(request, limit.measure)
  // A quantity limit gates only requests that carry its feature; an amount limit gates every one.
  const gates = (limit: LimitBalance) => limit.measure.type === "amount" || need(limit) > ZERO
  const failing = balance.limits.filter(
    (limit) => limit.enforce === "hard" && gates(limit) && limit.remaining < need(limit)
  )
  let blocking: LimitBalance | undefined = failing[0]
  if (!blocking) return null
  for (const limit of failing.slice(1)) {
    if (resetsLater(limit.resetsAt, blocking.resetsAt)) blocking = limit
  }
  let remedy: BlockedRemedy = "raise_limit"
  if (failing.every((limit) => limit.consumed + need(limit) <= limit.amount)) {
    remedy = "release_holds"
  } else if (
    failing.every((limit) => limit.resetsAt !== null && limit.held + need(limit) <= limit.amount)
  ) {
    remedy = "wait_for_reset"
  }
  if (remedy === "raise_limit")
    blocking = failing.find((limit) => need(limit) > limit.amount) ?? blocking
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
  request: Usage,
  now: number
): Extract<BudgetRejection, { code: "BUDGET_CLOSED" | "LIMIT_EXCEEDED" }> | null {
  if (config.closesAt !== null && isClosed(config, now)) {
    return { code: "BUDGET_CLOSED", closedAt: config.closesAt }
  }
  const blocked = blockingLimit(balance, request)
  return blocked ? { code: "LIMIT_EXCEEDED", blocked, balance } : null
}

/**
 * The amount that fits under every hard amount limit at this balance, never negative; null with no
 * hard amount limit.
 */
function roomOf(balance: BudgetBalance): Amount | null {
  if (balance.remaining === null) return null
  return balance.remaining > ZERO ? balance.remaining : ZERO
}

function resetsLater(a: number | null, b: number | null): boolean {
  if (b === null) return false
  return a === null || a > b
}

/**
 * Limits whose consumption first exceeds their amount on their measure, after `prior` more was
 * consumed since `balance` was read. A hard limit gets there only after recorded usage took the
 * room its holds and charges were checked against.
 */
function crossings(balance: BudgetBalance, consumed: Usage, prior = NO_USAGE): string[] {
  return balance.limits
    .filter((limit) => {
      const before = limit.consumed + measured(prior, limit.measure)
      return before <= limit.amount && before + measured(consumed, limit.measure) > limit.amount
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
  /** Signed on every measure: a reservation adds, a close removes. */
  held: Usage
  consumed: Usage
  /** Statements created or changed; the store upserts exactly these. */
  statements?: readonly Statement[]
}>

const unchanged = (row: Operation | null): Change => ({
  rows: [],
  row,
  held: NO_USAGE,
  consumed: NO_USAGE,
})

const negated = (usage: Usage) => subtractUsage(NO_USAGE, usage)

/**
 * Policy for one command against a view rolled to the clamped clock.
 * A rejection writes nothing.
 */
export function decide(
  command: BudgetCommand,
  view: Pick<
    BudgetView,
    "budget" | "ledger" | "target" | "expired" | "cards" | "statements" | "reservationsOpen"
  >,
  now: number
): Result<Change, UnPriceBudgetError> {
  const { cards, statements } = view
  if (command.type === "upsert") {
    return decideUpsert(command, view, now)
  }
  const budget = view.budget
  if (command.type === "sweep") {
    return Ok(
      budget
        ? decideSweep({ budget, ledger: view.ledger, cards, statements }, view.expired, now)
        : unchanged(null)
    )
  }
  if (budget) {
    return decideVerb(command, { budget, ledger: view.ledger, cards, statements }, view.target, now)
  }

  // A keyed verb may carry the budget to create when its key has none (ADR-0006 D8). The verb
  // then runs against the new budget in the same change, so a denial creates nothing.
  const definition = "ifMissing" in command ? command.ifMissing : undefined
  if (!definition) return reject({ code: "BUDGET_NOT_FOUND" })
  const created = decideUpsert(
    { type: "upsert", ...definition, mayLoosen: false },
    { budget: null, ledger: view.ledger, cards, reservationsOpen: false },
    now
  )
  if (created.err) return created
  const { configured } = created.val
  if (!configured) throw new Error(`creating ${definition.key} configured nothing`)
  const decided = decideVerb(
    command,
    { budget: configured.budget, ledger: view.ledger, cards, statements },
    view.target,
    now
  )
  if (decided.err) return decided
  return Ok({ ...decided.val, configured })
}

function decideVerb(
  command: Exclude<BudgetCommand, { type: "upsert" | "sweep" }>,
  state: Context,
  target: Operation | null,
  now: number
): Result<Change, UnPriceBudgetError> {
  switch (command.type) {
    case "get":
    case "statements":
    // Funding moves no operation row; `decideFunding` steps the wallet reservation.
    case "fund":
    case "applyFunding":
      return Ok(unchanged(null))
    case "registerStatements":
      return writesStatements(decideRegister(command.statements, state.statements, now))
    case "sealStatements":
      return writesStatements(Ok(decideSeal(command, state.statements, now)))
    case "completeStatements":
      return writesStatements(decideComplete(command.periodIds, state.statements, now))
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

function writesStatements(
  decided: Result<readonly Statement[], UnPriceBudgetError>
): Result<Change, UnPriceBudgetError> {
  if (decided.err) return decided
  return Ok({ ...unchanged(null), statements: decided.val })
}

type UpsertCommand = Extract<BudgetCommand, { type: "upsert" }>

/**
 * The pricing an upsert leaves the budget with: an existing budget keeps its own unless the caller
 * sets it.
 */
export function upsertPricing(
  command: UpsertCommand,
  budget: BudgetRecord | null
): BudgetPricing | undefined {
  return budget && !command.setsPricing ? budget.config.pricing : command.config.pricing
}

/** Whether an upsert creates the budget with pricing or changes the pricing it has. */
export function repricesBudget(command: UpsertCommand, budget: BudgetRecord | null): boolean {
  return !samePricing(budget?.config.pricing, upsertPricing(command, budget))
}

function decideUpsert(
  command: UpsertCommand,
  view: Pick<BudgetView, "budget" | "ledger" | "cards" | "reservationsOpen">,
  now: number
): Result<Change, UnPriceBudgetError> {
  const { budget, ledger } = view
  const { key, projectId, unit } = command
  const config = withPricing(command.config, upsertPricing(command, budget))
  // Only new pricing reaches the cards: each must be cached, price in the budget's unit, and suit
  // its features. Unchanged pricing was checked when it was set.
  const unpriceable =
    config.pricing?.cards && repricesBudget(command, budget)
      ? compatibleCards(config.pricing, unit, view.cards, now)
      : null
  if (!budget) {
    if (unpriceable?.err) return unpriceable
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
  if (unpriceable?.err) return unpriceable
  // An open hold settles under the pricing that estimated it; a lease never reaches a statement.
  if (view.reservationsOpen && repricesBudget(command, budget)) {
    return reject({ code: "RESERVATIONS_OPEN" })
  }
  const previous = new Map(budget.config.limits.map((limit) => [limit.id, limit]))
  for (const limit of config.limits) {
    const before = previous.get(limit.id)
    if (!before) continue
    const current = windowIdOf(before)
    const requested = windowIdOf(limit)
    if (current !== requested) {
      return reject({ code: "LIMIT_WINDOW_IMMUTABLE", limitId: limit.id, current, requested })
    }
    if (!sameMeasure(before.measure, limit.measure)) {
      return reject({
        code: "LIMIT_MEASURE_IMMUTABLE",
        limitId: limit.id,
        current: before.measure,
        requested: limit.measure,
      })
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

function withPricing(config: BudgetConfig, pricing: BudgetPricing | undefined): BudgetConfig {
  const { pricing: _requested, ...rest } = config
  return pricing === undefined ? rest : { ...rest, pricing }
}

/**
 * The cards the pricing names, each cached, in the budget's unit, and valid for the features it
 * prices: an `included` allowance only on a feature without dimensions whose rows price its meter.
 * A row that has ended stays cached to price late usage, so only rows in force or ahead are held to
 * the per-row rules; the card's own rules span every row.
 */
function compatibleCards(
  pricing: BudgetPricing,
  unit: string,
  cached: BudgetView["cards"],
  now: number
): Result<RateCards, UnPriceBudgetError> {
  const resolved = cardsOf(pricing, unit, cached)
  if (resolved.err) return resolved
  const priced = pricing.features.filter((feature) => feature.priced)
  const slugs = new Set(priced.map((feature) => feature.slug))
  const { base, overlay } = resolved.val
  for (const { card, rows } of overlay ? [base, overlay] : [base]) {
    const featureRows = rows.filter((row) => slugs.has(row.featureSlug))
    const current = featureRows.filter((row) => row.effectiveTo === null || row.effectiveTo > now)
    const violations = validateCard(card, featureRows, priced, current)
    if (violations.length > 0) {
      return reject({ code: "CARD_INCOMPATIBLE", cardId: card.id, violations })
    }
  }
  return resolved
}

/**
 * Closes every expired reservation into consumption: a timer cannot prove the work or the process
 * stopped, so a hold counts everything it permitted and a lease everything it was granted. An
 * estimate is consumed as its event priced where the positions stand, which the estimate bounds.
 * Held capacity becomes consumption in the current window and returns when that window rolls. A
 * late settle that repeats the hold's own request replays; another is refused.
 */
function decideSweep(
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
    const expiry = expiryOf({ ...state, statements: [...statements.values()] }, row, now)
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
function expiryOf(state: Context, hold: HoldOperation, now: number): Expiry {
  const { estimate, reserved } = hold
  if (!estimate) return { actual: reserved, statements: [], billing: {} }
  const event = { slug: estimate.slug, properties: estimate.properties }
  const settled = holdActual(hold, { event }, state, now)
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
  state: Context,
  now: number
): Result<{ usage: Usage; metered: Metered | null }, UnPriceBudgetError> {
  const metering = measure(input, state, hold.createdAt, now, false)
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

/**
 * Whether `input` repeats a request: the same event when the request was priced from one,
 * otherwise the same usage vector and no event.
 */
function repeats(input: UsageOrEvent, priced: BudgetEvent | undefined, usage: Usage): boolean {
  return input.event
    ? priced !== undefined && sameEvent(priced, input.event)
    : priced === undefined && sameUsage(usage, input.usage)
}

/**
 * A keyed command repeats its row when the verb, the usage on every measure, and (for a hold) the
 * TTL match.
 */
function sameRequest(
  row: HoldOperation | ChargeOperation,
  command: Extract<BudgetCommand, { type: "authorize" | "charge" | "record" }>
): boolean {
  const priced = row.kind === "hold" ? row.estimate : row.priced
  const usage = row.kind === "hold" ? row.reserved : row.usage
  if (!repeats(command, priced, usage)) return false
  if (command.type !== "authorize") return row.kind === command.type
  return row.kind === "hold" && row.ttlMs === (command.ttlMs ?? null)
}

function decideKeyed(
  command: Extract<BudgetCommand, { type: "authorize" | "charge" | "record" }>,
  state: Context,
  target: Operation | null,
  now: number
): Result<Change, UnPriceBudgetError> {
  const { idempotencyKey } = command
  // A replay answers from its row before anything is priced: prices may have changed since.
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

  // An estimate and a charge price at the clock; a record at the time the usage happened.
  const at = command.type === "record" ? command.occurredAt : now
  const metering = measure(command, state, at, now, command.type === "authorize")
  if (metering.err) return metering
  const { usage, metered } = metering.val

  const balance = balanceOf(state, now)
  // Recorded work already ran: refusing it would lose the count, not the spend.
  const rejection =
    command.type === "record" ? null : admissionRejection(config, balance, usage, now)
  if (rejection) return reject(rejection)

  if (command.type === "authorize") {
    const expiresAt = now + ttlMs
    const hold: HoldOperation = {
      kind: "hold",
      id: `h_${state.ledger.holdSeq + 1}`,
      idempotencyKey,
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
  const row: Operation = {
    kind: command.type,
    id: `o:${idempotencyKey}`,
    idempotencyKey,
    usage,
    createdAt: now,
    crossed: crossings(balance, usage),
    ...(metered && { priced: metered.priced }),
  }
  return Ok({ rows: [row], row, held: NO_USAGE, consumed: usage, ...movedBy(metered) })
}

/**
 * The usage a command reserves or consumes: its vector, or its event metered and priced at `at`. A
 * priced budget takes events only, so all it consumes reaches a statement.
 */
function measure(
  input: UsageOrEvent,
  state: Context,
  at: number,
  now: number,
  estimate: boolean
): Result<{ usage: Usage; metered: Metered | null }, UnPriceBudgetError> {
  const { budget, cards, statements } = state
  if (!input.event) {
    if (budget.config.pricing) return reject({ code: "EVENT_REQUIRED" })
    return Ok({ usage: usageOf(input.usage.amount, input.usage.quantities), metered: null })
  }
  const event = input.event
  const metered = meterEvent({ budget, cards, statements, event, at, now, estimate })
  if (metered.err) return metered
  return Ok({ usage: metered.val.usage, metered: metered.val })
}

/** The statements a consumed event moves. */
function movedBy(metered: Metered | null): Pick<Change, "statements"> {
  return metered ? { statements: metered.statements } : {}
}

/** A hold's or a lease's TTL: from MIN_HOLD_TTL_MS up to the budget's `holds.maxTtlMs`. */
function invalidTtl(ttlMs: number, maxTtlMs: number) {
  if (Number.isSafeInteger(ttlMs) && ttlMs >= MIN_HOLD_TTL_MS && ttlMs <= maxTtlMs) return null
  return reject({ code: "INVALID_TTL", ttlMs, minTtlMs: MIN_HOLD_TTL_MS, maxTtlMs })
}

/**
 * Debits first, against every hard amount limit, like an authorize, and grants what fits: near a
 * limit less than asked for. Nothing fitting is written as a refused lease: a lease key's first
 * answer is final, so a late copy of a refused request cannot take capacity no process holds. The
 * same key, amount, and TTL replay the grant or the refusal.
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
  // A lease spends an amount in the caller's memory, which no statement would ever see.
  if (config.pricing) return reject({ code: "EVENT_REQUIRED" })
  const invalid = invalidTtl(ttlMs, config.holds.maxTtlMs)
  if (invalid) return invalid
  if (config.closesAt !== null && isClosed(config, now)) {
    return reject({ code: "BUDGET_CLOSED", closedAt: config.closesAt })
  }
  const balance = balanceOf(state, now)
  const room = roomOf(balance)
  const granted = room === null || room >= amount ? amount : room
  const blocked =
    granted === ZERO ? blockingLimit(amountLimitsOf(balance), amountUsage(amount)) : null
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
  return Ok({ rows: [lease], row: lease, held: amountUsage(granted), consumed: NO_USAGE })
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
  const delta = amountUsage(captured - lease.captured)
  const crossed = crossings(balance, delta)
  if (request.final) {
    const row: LeaseOperation = {
      ...lease,
      captured,
      last: { seq, request, extended: ZERO, denied: null, crossed },
      state: { status: "closed", closedAt: now },
    }
    const held = amountUsage(lease.captured - lease.granted)
    return Ok({ rows: [row], row, held, consumed: delta })
  }

  // The extension is judged after the capture it travels with.
  const { ledger } = state
  const afterCapture = amountLimitsOf(
    balanceOf(
      {
        ...state,
        ledger: {
          ...ledger,
          held: subtractUsage(ledger.held, delta),
          usage: consume(ledger.usage, delta),
        },
      },
      now
    )
  )
  const { config } = state.budget
  const closedAt = config.closesAt !== null && isClosed(config, now) ? config.closesAt : null
  const room = closedAt === null ? roomOf(afterCapture) : ZERO
  const extended = room === null || room >= request.extend ? request.extend : room
  let denied: ExtensionDenial | null = null
  if (extended < request.extend && closedAt !== null) {
    denied = { code: "BUDGET_CLOSED", closedAt }
  } else if (extended < request.extend) {
    const blocked = blockingLimit(afterCapture, amountUsage(request.extend))
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
  return Ok({
    rows: [row],
    row,
    held: subtractUsage(amountUsage(extended), delta),
    consumed: delta,
  })
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
      const settled = holdActual(hold.val, input, state, now)
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
