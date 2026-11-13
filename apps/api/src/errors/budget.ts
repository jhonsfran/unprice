import { formatAmount } from "@unprice/money"
import type { Blocked, BudgetBalance, UnPriceBudgetError } from "@unprice/services/budgets"
import { balanceToWire, toWire } from "~/routes/budgets/wire"
import { UnpriceApiError } from "./api-error"

export const exceededDetails = (blocked: Blocked, balance: BudgetBalance) => ({
  kind: "budget_exceeded" as const,
  blocked: toWire(blocked),
  balance: balanceToWire(balance),
})

export const closedDetails = (closedAt: number) => ({ kind: "budget_closed" as const, closedAt })

/**
 * The HTTP error a budget rejection maps to: a denial (LIMIT_EXCEEDED, WALLET_EMPTY) is 402, a
 * request the budget cannot take as sent is 400, a missing budget or record 404, a state
 * conflict (TOO_LATE, PERIOD_CLOSED, NO_STATEMENT, IDEMPOTENCY_CONFLICT, BUDGET_CLOSED) 409, and a
 * wallet that refused its funding (FUNDING_FAILED) 500.
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
    // The wallet side needs an operator: the caller cannot fix it, and the detail stays in the logs.
    case "FUNDING_FAILED":
      return new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "The customer's wallet could not fund this usage",
        cause: error,
      })
    case "INVALID_TTL":
    case "INVALID_OCCURRED_AT":
    case "INVALID_USAGE":
    case "NOT_PRICED":
    case "UNKNOWN_EVENT":
    case "EVENT_REQUIRED":
      return new UnpriceApiError({ code: "BAD_REQUEST", message, cause: error })
  }
}
