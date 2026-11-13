/** Budget command dispatch and keyed requests rules. */

import { Ok, type Result } from "@unprice/error"
import { type Funded, admissionRejection, balanceOf, crossings } from "./balance"
import {
  type BudgetRecord,
  type ConfigChange,
  MIN_HOLD_TTL_MS,
  OPERATION_RETENTION_MS,
  RECORD_ACCEPT_WINDOW_MS,
  RECORD_FUTURE_SKEW_MS,
  isClosed,
} from "./config"
import { decideAuthorize, decideRelease, decideSettle, decideSweep } from "./holds"
import { decideLease, decideReport } from "./leases"
import { type Metered, meterEvent, sameEvent } from "./meter"
import type {
  BudgetCommand,
  BudgetEvent,
  BudgetOutcome,
  BudgetView,
  ChargeOperation,
  HoldOperation,
  Ledger,
  Operation,
  OutcomeOf,
  Statement,
  UsageOrEvent,
} from "./model"
import { type UnPriceBudgetError, reject } from "./rejections"
import { decideComplete, decideRegister, decideSeal } from "./statements"
import { decideUpsert, upsertFacts } from "./upsert"
import { NO_USAGE, type Usage, sameUsage, subtractUsage, usageOf } from "./usage"

/** What a verb decides against: the funded budget plus the cards and statements it prices on. */
export type Context = Funded & Pick<BudgetView, "cards" | "statements">

// Decide

/**
 * What one accepted command changes. `rows` are the rows it wrote, as new objects; `row` is the row
 * its outcome reads, written or replayed. No rows and no config is a read or an idempotent replay.
 */
export type Change = Readonly<{
  configured?: Readonly<{
    budget: BudgetRecord
    changes: readonly ConfigChange[]
    usage: Ledger["usage"]
    unitChanged: boolean
  }>
  rows: readonly Operation[]
  row: Operation | null
  /** Signed on every measure: a reservation adds, a close removes. */
  held: Usage
  consumed: Usage
  /** Statements created or changed; the store upserts exactly these. */
  statements?: readonly Statement[]
}>

export const unchanged = (row: Operation | null): Change => ({
  rows: [],
  row,
  held: NO_USAGE,
  consumed: NO_USAGE,
})

export const negated = (usage: Usage) => subtractUsage(NO_USAGE, usage)

/**
 * Policy for one command against a view rolled to the clamped clock.
 * A rejection writes nothing.
 */
export function decide(
  command: BudgetCommand,
  view: Pick<
    BudgetView,
    | "budget"
    | "ledger"
    | "target"
    | "expired"
    | "cards"
    | "statements"
    | "reservationsOpen"
    | "upsert"
  >,
  now: number
): Result<Change, UnPriceBudgetError> {
  const { cards, statements } = view
  if (command.type === "upsert") {
    return decideUpsert(command, view, now, view.upsert ?? upsertFacts(command, view.budget))
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

/**
 * Whether `input` repeats a request: the same event when the request was priced from one,
 * otherwise the same usage vector and no event.
 */
export function repeats(
  input: UsageOrEvent,
  priced: BudgetEvent | undefined,
  usage: Usage
): boolean {
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
  const metering = measure(command, state, at, command.type === "authorize")
  if (metering.err) return metering
  const { usage, metered } = metering.val

  const balance = balanceOf(state, now)
  // Recorded work already ran: refusing it would lose the count, not the spend.
  const rejection =
    command.type === "record" ? null : admissionRejection(config, balance, usage, now)
  if (rejection) return reject(rejection)

  if (command.type === "authorize")
    return decideAuthorize(command, state, usage, metered, ttlMs, now)

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
export function measure(
  input: UsageOrEvent,
  state: Context,
  at: number,
  estimate: boolean
): Result<{ usage: Usage; metered: Metered | null }, UnPriceBudgetError> {
  const { budget, cards, statements } = state
  if (!input.event) {
    if (budget.config.pricing) return reject({ code: "EVENT_REQUIRED" })
    return Ok({ usage: usageOf(input.usage.amount, input.usage.quantities), metered: null })
  }
  const event = input.event
  const metered = meterEvent({ budget, cards, statements, event, at, estimate })
  if (metered.err) return metered
  return Ok({ usage: metered.val.usage, metered: metered.val })
}

/** The statements a consumed event moves. */
export function movedBy(metered: Metered | null): Pick<Change, "statements"> {
  return metered ? { statements: metered.statements } : {}
}

/** A hold's or a lease's TTL: from MIN_HOLD_TTL_MS up to the budget's `holds.maxTtlMs`. */
export function invalidTtl(ttlMs: number, maxTtlMs: number) {
  if (Number.isSafeInteger(ttlMs) && ttlMs >= MIN_HOLD_TTL_MS && ttlMs <= maxTtlMs) return null
  return reject({ code: "INVALID_TTL", ttlMs, minTtlMs: MIN_HOLD_TTL_MS, maxTtlMs })
}

/** Whether a request can define a budget at an unknown key. */
export function definesBudget(request: Pick<BudgetCommand, "type">): boolean {
  return request.type === "upsert" || ("ifMissing" in request && !!request.ifMissing)
}

/** Every command answers with the outcome of its own type. */
export function isOutcomeOf<T extends BudgetOutcome["type"]>(
  outcome: BudgetOutcome,
  type: T
): outcome is OutcomeOf<T> {
  return outcome.type === type
}
