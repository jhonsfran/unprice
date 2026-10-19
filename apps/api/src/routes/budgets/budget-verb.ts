import type { ApiKeyExtended } from "@unprice/db/validators"
import { formatAmount } from "@unprice/money"
import {
  type Blocked,
  type BudgetBalance,
  type BudgetOutcome,
  type BudgetSnapshot,
  type OutcomeOf,
  type UnPriceBudgetError,
  formatBudgetConfig,
} from "@unprice/services/budgets"
import {
  type BudgetVerbRequest,
  type ExecuteBudgetCommandInput,
  executeBudgetCommand,
} from "@unprice/services/use-cases"
import type { Context } from "hono"
import { setMetric } from "hono/timing"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { CloudflareBudgetClient } from "~/ingestion/budget/client"

export const BUDGET_REMAINING_HEADER = "Unprice-Budget-Remaining"

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
  const result = await callBudget(c, { projectId, key, request })
  if (result.err) throw budgetApiError(c, result.err)
  setRemaining(c, result.val)
  return result.val
}

/**
 * Runs the verb on the budget's Durable Object and reports the call on the request's wide event
 * (`budget_*` in Axiom) and on Server-Timing. Timed by hand, apart from key auth and the rest of
 * the Worker.
 */
async function callBudget<R extends BudgetVerbRequest>(
  c: Context<HonoEnv>,
  input: ExecuteBudgetCommandInput<R>
) {
  const budgets = new CloudflareBudgetClient(c.env)
  const startedAt = performance.now()
  let outcome = "error"
  try {
    const result = await executeBudgetCommand({ budgets }, input)
    outcome = result.err ? result.err.rejection.code : "ok"
    return result
  } finally {
    const doMs = performance.now() - startedAt
    setMetric(c, "budget", doMs)
    c.get("logger").set({
      budget: {
        command: input.request.type,
        outcome,
        do_ms: doMs,
      },
    })
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

/**
 * A budget on the wire: its config with every default filled, amounts as decimals, and closesAt in
 * epoch ms, as `formatBudgetConfig` returns it.
 */
export function budgetToWire(budget: BudgetSnapshot) {
  const { key, unit, version, closed, balance, operations } = budget
  const config = formatBudgetConfig(budget)
  return { key, unit, version, ...config, closed, balance: toWire(balance), operations }
}

const exceededDetails = (blocked: Blocked, balance: BudgetBalance) => ({
  kind: "budget_exceeded" as const,
  blocked: toWire(blocked),
  balance: toWire(balance),
})

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

function budgetApiError(c: Context<HonoEnv>, error: UnPriceBudgetError): UnpriceApiError {
  const { rejection } = error
  const message = error.message
  switch (rejection.code) {
    case "LIMIT_EXCEEDED":
      setRemaining(c, rejection)
      return new UnpriceApiError({
        code: "BUDGET_EXCEEDED",
        message,
        details: exceededDetails(rejection.blocked, rejection.balance),
      })
    case "BUDGET_CLOSED":
      return new UnpriceApiError({
        code: "CONFLICT",
        message,
        details: closedDetails(rejection.closedAt),
      })
    case "HOLD_AMOUNT_EXCEEDED":
      return new UnpriceApiError({
        code: "CONFLICT",
        message,
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
      })
    case "IDEMPOTENCY_CONFLICT":
    case "HOLD_CLOSED":
    case "HOLD_RETIRED":
    case "UNIT_IMMUTABLE":
    case "LIMIT_WINDOW_IMMUTABLE":
    case "TOO_LATE":
    case "LEASE_CLOSED":
    case "LEASE_SEQ_CONFLICT":
    case "LEASE_CAPTURE_OUT_OF_RANGE":
      return new UnpriceApiError({ code: "CONFLICT", message })
    case "BUDGET_NOT_FOUND":
    case "HOLD_NOT_FOUND":
    case "LEASE_NOT_FOUND":
      return new UnpriceApiError({ code: "NOT_FOUND", message })
    case "INVALID_TTL":
    case "INVALID_OCCURRED_AT":
      return new UnpriceApiError({ code: "BAD_REQUEST", message })
  }
}

function setRemaining(c: Context<HonoEnv>, carrier: BudgetOutcome | { balance: BudgetBalance }) {
  const balance =
    "budget" in carrier ? carrier.budget.balance : "balance" in carrier ? carrier.balance : null
  if (!balance) return
  c.header(
    BUDGET_REMAINING_HEADER,
    balance.remaining === null ? "unlimited" : formatAmount(balance.remaining)
  )
}
