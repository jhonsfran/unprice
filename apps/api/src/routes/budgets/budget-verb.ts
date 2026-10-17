import { formatAmount } from "@unprice/money"
import {
  type BudgetBalance,
  type BudgetOutcome,
  type BudgetSnapshot,
  type UnPriceBudgetError,
  formatBudgetConfig,
} from "@unprice/services/budgets"
import { type BudgetVerbRequest, executeBudgetCommand } from "@unprice/services/use-cases"
import type { Context } from "hono"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { CloudflareBudgetClient } from "~/ingestion/budget/client"

export const BUDGET_REMAINING_HEADER = "Unprice-Budget-Remaining"

/**
 * Authenticates, runs one verb against the budget at `key`, and sets the remaining header.
 * Returns the verb's outcome, or throws the HTTP error its rejection maps to.
 */
export async function runBudgetVerb<R extends BudgetVerbRequest>(
  c: Context<HonoEnv>,
  key: string,
  request: R
) {
  const apiKey = await keyAuth(c)
  const result = await executeBudgetCommand(
    { budgets: new CloudflareBudgetClient(c.env) },
    { projectId: apiKey.projectId, key, request }
  )
  if (result.err) throw budgetApiError(c, result.err)
  setRemaining(c, result.val)
  return result.val
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

/** A budget on the wire: its config as it was sent (instants as ISO strings), amounts as decimals. */
export function budgetToWire(budget: BudgetSnapshot) {
  const { key, unit, version, closed, balance } = budget
  return { key, unit, version, ...formatBudgetConfig(budget), closed, balance: toWire(balance) }
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
        details: {
          kind: "budget_exceeded",
          blocked: toWire(rejection.blocked),
          balance: toWire(rejection.balance),
        },
      })
    case "BUDGET_CLOSED":
      return new UnpriceApiError({
        code: "CONFLICT",
        message,
        details: { kind: "budget_closed", closedAt: rejection.closedAt },
      })
    case "IDEMPOTENCY_CONFLICT":
    case "HOLD_CLOSED":
    case "HOLD_RETIRED":
    case "UNIT_IMMUTABLE":
    case "LIMIT_WINDOW_IMMUTABLE":
    case "TOO_LATE":
      return new UnpriceApiError({ code: "CONFLICT", message })
    case "BUDGET_NOT_FOUND":
    case "HOLD_NOT_FOUND":
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
