import type { BudgetBalanceResponse, BudgetResponse } from "@unprice/db/validators"
import type { Result } from "@unprice/error"
import {
  type BudgetBalance,
  type BudgetOutcome,
  type BudgetSnapshot,
  type UnPriceBudgetError,
  formatAmount,
} from "@unprice/services/budgets"
import type { Context } from "hono"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

export const BUDGET_REMAINING_HEADER = "Unprice-Budget-Remaining"

type OutcomeOf<T extends BudgetOutcome["type"]> = BudgetOutcome & { type: T }

/** The outcome of a verb, or the HTTP error its rejection maps to. Sets the remaining header. */
export function budgetOutcome<T extends BudgetOutcome["type"]>(
  c: Context<HonoEnv>,
  result: Result<BudgetOutcome, UnPriceBudgetError>,
  type: T
): OutcomeOf<T> {
  if (result.err) throw budgetApiError(c, result.err)
  const outcome = result.val
  if (outcome.type === "sweep" || !isOutcome(outcome, type)) {
    throw new Error(`budget ${type} returned a ${outcome.type} outcome`)
  }
  setRemaining(c, "budget" in outcome ? outcome.budget.balance : outcome.balance)
  return outcome
}

function isOutcome<T extends BudgetOutcome["type"]>(
  outcome: BudgetOutcome,
  type: T
): outcome is OutcomeOf<T> {
  return outcome.type === type
}

function budgetApiError(c: Context<HonoEnv>, error: UnPriceBudgetError): UnpriceApiError {
  const { rejection } = error
  const message = error.message
  switch (rejection.code) {
    case "LIMIT_EXCEEDED": {
      setRemaining(c, rejection.balance)
      const { blocked } = rejection
      return new UnpriceApiError({
        code: "BUDGET_EXCEEDED",
        message,
        details: {
          kind: "budget_exceeded",
          blocked: {
            ...blocked,
            remaining: formatAmount(blocked.remaining),
            held: formatAmount(blocked.held),
          },
          balance: toWireBalance(rejection.balance),
        },
      })
    }
    case "IDEMPOTENCY_CONFLICT":
    case "HOLD_CLOSED":
    case "UNIT_IMMUTABLE":
      return new UnpriceApiError({ code: "CONFLICT", message })
    case "BUDGET_NOT_FOUND":
    case "HOLD_NOT_FOUND":
      return new UnpriceApiError({ code: "NOT_FOUND", message })
    case "INVALID_AMOUNT":
    case "INVALID_CONFIG":
    case "INVALID_TTL":
      return new UnpriceApiError({ code: "BAD_REQUEST", message })
  }
}

function setRemaining(c: Context<HonoEnv>, balance: BudgetBalance) {
  c.header(
    BUDGET_REMAINING_HEADER,
    balance.remaining === null ? "unlimited" : formatAmount(balance.remaining)
  )
}

export function toWireBalance(balance: BudgetBalance): BudgetBalanceResponse {
  return {
    remaining: balance.remaining === null ? null : formatAmount(balance.remaining),
    held: formatAmount(balance.held),
    limits: balance.limits.map((limit) => ({
      ...limit,
      amount: formatAmount(limit.amount),
      consumed: formatAmount(limit.consumed),
      held: formatAmount(limit.held),
      remaining: formatAmount(limit.remaining),
    })),
    asOf: balance.asOf,
  }
}

export function toWireBudget(budget: BudgetSnapshot): BudgetResponse {
  const { onUnavailable } = budget.config
  return {
    key: budget.key,
    unit: budget.unit,
    version: budget.version,
    limits: budget.config.limits.map((limit) => ({ ...limit, amount: formatAmount(limit.amount) })),
    holds: budget.config.holds,
    onUnavailable:
      typeof onUnavailable === "string"
        ? onUnavailable
        : { allowUpTo: formatAmount(onUnavailable.allowUpTo) },
    balance: toWireBalance(budget.balance),
  }
}
