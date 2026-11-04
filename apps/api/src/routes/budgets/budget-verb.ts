import type { ApiKeyExtended } from "@unprice/db/validators"
import type { Result } from "@unprice/error"
import { formatAmount } from "@unprice/money"
import {
  type Blocked,
  type BudgetBalance,
  type BudgetInspectQuery,
  type BudgetOutcome,
  type BudgetRejection,
  type BudgetSnapshot,
  type Operation,
  type OutcomeOf,
  type ReservationOperation,
  type UnPriceBudgetError,
  type Usage,
  type WindowPeriod,
  formatBudgetConfig,
} from "@unprice/services/budgets"
import {
  type BudgetAddress,
  type BudgetVerbRequest,
  executeBudgetCommand,
  rateCardSource,
  walletFunding,
} from "@unprice/services/use-cases"
import type { Context } from "hono"
import { setMetric } from "hono/timing"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { CloudflareBudgetClient } from "~/ingestion/budget/client"

export const BUDGET_REMAINING_HEADER = "Unprice-Budget-Remaining"

/**
 * Keys Unprice writes itself: a customer's subscription budget is `unprice:customer:<customerId>`
 * (ADR-0008 D1). A public call may read and spend under one, never create or define it.
 */
export const RESERVED_KEY_PREFIX = "unprice:"

/**
 * Runs one verb against the budget at `key` and sets the remaining header. Authenticates a runtime
 * key unless the route already authenticated `apiKey` itself. Returns the verb's outcome, or
 * throws the HTTP error its rejection maps to.
 */
export async function runBudgetVerb<R extends BudgetVerbRequest>(
  c: Context<HonoEnv>,
  key: string,
  request: R,
  apiKey?: Pick<ApiKeyExtended, "projectId">
) {
  const { projectId } = apiKey ?? (await keyAuth(c))
  const defines = request.type === "upsert" || ("ifMissing" in request && request.ifMissing)
  if (defines && key.startsWith(RESERVED_KEY_PREFIX)) {
    throw new UnpriceApiError({
      code: "FORBIDDEN",
      message: `Keys starting with ${RESERVED_KEY_PREFIX} are written by Unprice; a call cannot create or upsert one`,
    })
  }
  const budgets = new CloudflareBudgetClient(c.env)
  const { budgetCatalog, rateCards, wallet } = c.get("services")
  const result = await callBudget(c, request.type, () =>
    executeBudgetCommand(
      {
        budgets,
        cards: rateCardSource(rateCards),
        wallet: walletFunding(wallet),
        services: { budgetCatalog },
        logger: c.get("logger"),
        waitUntil: c.get("waitUntil"),
      },
      { projectId, key, request }
    )
  )
  if (result.err) throw budgetApiError(c, result.err)
  setBudgetRemaining(c, result.val)
  return result.val
}

/**
 * Inspects the budget at `address` for the dashboard and reports the call like a verb. Returns the
 * inspection, or throws the HTTP error its rejection maps to.
 */
export async function inspectBudget(
  c: Context<HonoEnv>,
  address: BudgetAddress,
  query: BudgetInspectQuery
) {
  const budgets = new CloudflareBudgetClient(c.env)
  const result = await callBudget(c, "inspect", () => budgets.inspect(address, query))
  if (result.err) throw budgetApiError(c, result.err)
  return result.val
}

/**
 * Runs one call on the budget's Durable Object and reports it on the request's wide event
 * (`budget_*` in Axiom) and on Server-Timing. Timed by hand, apart from key auth and the rest of
 * the Worker.
 */
async function callBudget<T>(
  c: Context<HonoEnv>,
  command: string,
  call: () => Promise<Result<T, UnPriceBudgetError>>
) {
  const startedAt = performance.now()
  let outcome = "error"
  try {
    const result = await call()
    outcome = result.err ? result.err.rejection.code : "ok"
    return result
  } finally {
    const doMs = performance.now() - startedAt
    setMetric(c, "budget", doMs)
    c.get("logger").set({ budget: { command, outcome, do_ms: doMs } })
  }
}

/** A budget value on the wire: every amount (a `bigint`) becomes its canonical decimal string. */
export type Wire<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Wire<T[K]> }
      : T

export function toWire<T>(value: T): Wire<T> {
  return wire(value) as Wire<T>
}

function wire(value: unknown): unknown {
  if (typeof value === "bigint") return formatAmount(value)
  if (Array.isArray(value)) return value.map(wire)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)]))
  }
  return value
}

// The public wire carries amounts only. The core counts a usage vector (the amount and a quantity
// per feature), so every vector projects to its amount here, and a limit that caps a quantity names
// its `feature`, as `formatBudgetConfig` does.

export function amountToWire(usage: Usage): string {
  return formatAmount(usage.amount)
}

export function balanceToWire({ remaining, held, limits, asOf }: BudgetBalance) {
  return {
    remaining: remaining === null ? null : formatAmount(remaining),
    held: amountToWire(held),
    limits: limits.map(({ measure, ...limit }) => ({
      ...toWire(limit),
      ...(measure.type === "quantity" && { feature: measure.feature }),
    })),
    asOf,
  }
}

export function periodToWire({ consumed, ...period }: WindowPeriod) {
  return { ...period, consumed: amountToWire(consumed) }
}

/** A hold or lease row as the dashboard's inspection reads it. */
export function reservationToWire(row: ReservationOperation) {
  if (row.kind === "lease") return toWire(row)
  const { reserved, state, ...hold } = row
  return {
    // An estimate carries the bigints of the event it priced.
    ...toWire(hold),
    amount: amountToWire(reserved),
    state:
      state.status === "settled" ? { ...toWire(state), actual: amountToWire(state.actual) } : state,
  }
}

/** An operation row as the dashboard's inspection reads it. */
export function operationToWire(row: Operation) {
  if (row.kind === "hold" || row.kind === "lease") return reservationToWire(row)
  const { usage, ...operation } = row
  return { ...toWire(operation), amount: amountToWire(usage) }
}

/**
 * A budget on the wire: its config with every default filled, amounts as decimals, and closesAt in
 * epoch ms, as `formatBudgetConfig` returns it.
 */
export function budgetToWire(budget: BudgetSnapshot) {
  const { key, unit, version, closed, balance, operations } = budget
  const config = formatBudgetConfig(budget)
  return { key, unit, version, ...config, closed, balance: balanceToWire(balance), operations }
}

const exceededDetails = (blocked: Blocked, balance: BudgetBalance) => ({
  kind: "budget_exceeded" as const,
  blocked: toWire(blocked),
  balance: balanceToWire(balance),
})

export function releaseToWire({
  released,
  balance,
  ...outcome
}: Omit<OutcomeOf<"release">, "type">) {
  return { ...toWire(outcome), released: amountToWire(released), balance: balanceToWire(balance) }
}

/** A charge or record: the amount it consumed. */
export function consumedToWire({
  usage,
  balance,
  ...outcome
}: Omit<OutcomeOf<"charge"> | OutcomeOf<"record">, "type" | "created">) {
  return { ...toWire(outcome), amount: amountToWire(usage), balance: balanceToWire(balance) }
}

/** An admission rejection as `details` carries it, with its code instead of a kind. */
export function admissionToWire(
  rejection: Extract<BudgetRejection, { code: "BUDGET_CLOSED" | "LIMIT_EXCEEDED" }>
) {
  if (rejection.code === "BUDGET_CLOSED") return rejection
  const { kind: _, ...details } = exceededDetails(rejection.blocked, rejection.balance)
  return { code: rejection.code, ...details }
}

const closedDetails = (closedAt: number) => ({ kind: "budget_closed" as const, closedAt })

/** A report's extension; a short one carries the details a denied charge would have. */
export function extensionToWire(
  { requested, granted, denied }: OutcomeOf<"report">["extension"],
  balance: BudgetBalance
) {
  const wire = { requested: formatAmount(requested), granted: formatAmount(granted) }
  if (denied === null) return wire
  const details =
    denied.code === "LIMIT_EXCEEDED"
      ? exceededDetails(denied.blocked, balance)
      : closedDetails(denied.closedAt)
  return { ...wire, denied: details }
}

/** The HTTP error a budget rejection maps to; a denial also sets the remaining header. */
export function budgetApiError(c: Context<HonoEnv>, error: UnPriceBudgetError): UnpriceApiError {
  if (error.rejection.code === "LIMIT_EXCEEDED") setBudgetRemaining(c, error.rejection)
  return budgetRejectionError(error)
}

/**
 * The HTTP error a budget rejection maps to: a denial (LIMIT_EXCEEDED, WALLET_EMPTY) is 402, a
 * request the budget cannot take as sent is 400, a missing budget or record 404, and a state
 * conflict (TOO_LATE, PERIOD_CLOSED, NO_STATEMENT, IDEMPOTENCY_CONFLICT, BUDGET_CLOSED) 409.
 */
export function budgetRejectionError(error: UnPriceBudgetError): UnpriceApiError {
  const { rejection } = error
  const message = error.message
  switch (rejection.code) {
    case "LIMIT_EXCEEDED":
      return new UnpriceApiError({
        code: "BUDGET_EXCEEDED",
        message,
        cause: error,
        details: exceededDetails(rejection.blocked, rejection.balance),
      })
    // A prepaid payer's wallet could not fund the usage: a denial like a limit, without its details.
    case "WALLET_EMPTY":
      return new UnpriceApiError({ code: "BUDGET_EXCEEDED", message, cause: error })
    case "BUDGET_CLOSED":
      return new UnpriceApiError({
        code: "CONFLICT",
        message,
        cause: error,
        details: closedDetails(rejection.closedAt),
      })
    case "HOLD_AMOUNT_EXCEEDED":
      return new UnpriceApiError({
        code: "CONFLICT",
        message,
        cause: error,
        details: {
          kind: "hold_amount_exceeded",
          holdId: rejection.holdId,
          maximum: formatAmount(rejection.maximum),
          actual: formatAmount(rejection.actual),
        },
      })
    case "LIMIT_BELOW_USAGE":
      return new UnpriceApiError({
        code: "CONFLICT",
        message,
        cause: error,
        details: {
          kind: "limit_below_usage",
          limitId: rejection.limitId,
          minimum: formatAmount(rejection.minimum),
          requested: formatAmount(rejection.requested),
        },
      })
    case "WINDOW_CAPACITY_EXCEEDED":
      return new UnpriceApiError({
        code: "CONFLICT",
        message,
        cause: error,
        details: {
          kind: "window_capacity_exceeded",
          maximum: rejection.maximum,
          retained: rejection.retained,
        },
      })
    case "LOOSENING_FORBIDDEN":
      return new UnpriceApiError({
        code: "INSUFFICIENT_PERMISSIONS",
        message: `${message}. A runtime key can create or tighten a budget; raising or removing a hard limit, making it soft, or clearing or postponing closesAt needs a config key.`,
        cause: error,
      })
    case "IDEMPOTENCY_CONFLICT":
    case "HOLD_CLOSED":
    case "HOLD_RETIRED":
    case "UNIT_IMMUTABLE":
    case "LIMIT_WINDOW_IMMUTABLE":
    case "LIMIT_MEASURE_IMMUTABLE":
    case "TOO_LATE":
    case "LEASE_CLOSED":
    case "LEASE_SEQ_CONFLICT":
    case "LEASE_CAPTURE_OUT_OF_RANGE":
    case "PERIOD_CLOSED":
    case "NO_STATEMENT":
    case "STATEMENT_CONFLICT":
    case "STATEMENT_OVERLAP":
    case "STATEMENT_NOT_SEALED":
    case "UNIT_MISMATCH":
    case "CARD_INCOMPATIBLE":
    case "INCLUDED_NOT_APPLICABLE":
    case "RESERVATIONS_OPEN":
    // Reaches a caller only when the refresh before the retry was itself stale; a retry refreshes.
    case "CARDS_STALE":
    // Internal to the funding protocol; reaches a caller only when a concurrent call raced it.
    case "FUNDING_REQUIRED":
    case "FUNDING_SEQ_CONFLICT":
      return new UnpriceApiError({ code: "CONFLICT", message, cause: error })
    case "BUDGET_NOT_FOUND":
    case "HOLD_NOT_FOUND":
    case "LEASE_NOT_FOUND":
    case "STATEMENT_NOT_FOUND":
    case "CARD_NOT_FOUND":
      return new UnpriceApiError({ code: "NOT_FOUND", message, cause: error })
    case "INVALID_TTL":
    case "INVALID_OCCURRED_AT":
    case "INVALID_USAGE":
    case "NOT_PRICED":
    case "UNKNOWN_EVENT":
    case "EVENT_REQUIRED":
      return new UnpriceApiError({ code: "BAD_REQUEST", message, cause: error })
  }
}

export function setBudgetRemaining(
  c: Context<HonoEnv>,
  carrier: BudgetOutcome | { balance: BudgetBalance }
) {
  const balance =
    "budget" in carrier ? carrier.budget.balance : "balance" in carrier ? carrier.balance : null
  if (!balance) return
  c.header(
    BUDGET_REMAINING_HEADER,
    balance.remaining === null ? "unlimited" : formatAmount(balance.remaining)
  )
}
