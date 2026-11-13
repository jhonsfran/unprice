import type { UsageEventResult } from "@unprice/db/validators"
import {
  type MeterPayerUsageDeps,
  type MeterPayerUsageInput,
  type PayerUsageResult,
  meterPayerUsage,
} from "@unprice/services/use-cases"
import type { Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { UnpriceApiError } from "~/errors"
import { budgetRejectionError } from "~/errors/budget"
import type { HonoEnv } from "~/hono/env"
import { journalOf } from "~/ingestion/budget/journal"
import { batchOutcome, budgetCommandDeps, callBudget } from "../budgets/budget-verb"
import { amountToWire } from "../budgets/wire"

/** A batch event whose budget could not be reached: never decided, so a retry with its key is safe. */
export const USAGE_UNAVAILABLE = {
  code: "UNAVAILABLE",
  status: 503,
  reason: "BUDGET_UNAVAILABLE",
  message:
    "The customer's budget could not be reached; retry the event with the same idempotency key",
} as const

/** A batch event naming a customer the API key cannot use. */
export const USAGE_CUSTOMER_FORBIDDEN = {
  code: "FORBIDDEN",
  status: 403,
  reason: "CUSTOMER_FORBIDDEN",
} as const

/**
 * What `meterPayerUsage` needs in the API worker: the budget command's deps (billing's compile
 * created the payer budget; a usage call never defines it) and the journal stream for refused events.
 */
export function payerUsageDeps(c: Context<HonoEnv>): MeterPayerUsageDeps {
  return { ...budgetCommandDeps(c), journal: journalOf(c.env) }
}

/**
 * Meters a batch through the payer budgets and reports it once on the wide event and Server-Timing:
 * one `do_ms` for the whole batch and a count per outcome, so events do not overwrite each other.
 */
export function meterPayerUsageReported(c: Context<HonoEnv>, input: MeterPayerUsageInput) {
  return callBudget(
    c,
    input.verb,
    () => meterPayerUsage(payerUsageDeps(c), input),
    (results) => batchOutcome(results.map(usageOutcome))
  )
}

/** One event's outcome: "ok", the budget's rejection code, or UNAVAILABLE. */
function usageOutcome(answer: PayerUsageResult): string {
  if ("unavailable" in answer) return USAGE_UNAVAILABLE.code
  return answer.result.err ? answer.result.err.rejection.code : "ok"
}

/** One event's answer in a batch: what it cost, or the error a single call would have returned. */
export function usageResultToWire(answer: PayerUsageResult): UsageEventResult {
  const { customerId, idempotencyKey } = answer.event
  if ("unavailable" in answer) {
    return { status: "rejected", customerId, idempotencyKey, error: { ...USAGE_UNAVAILABLE } }
  }
  const { result } = answer
  if (result.err) {
    const error = budgetRejectionError(result.err)
    return {
      status: "rejected",
      customerId,
      idempotencyKey,
      error: {
        code: error.code,
        status: error.status,
        reason: result.err.rejection.code,
        message: error.message,
      },
    }
  }
  const { usage, crossed, replayed } = result.val
  return {
    status: "accepted",
    customerId,
    idempotencyKey,
    amount: amountToWire(usage),
    crossed: [...crossed],
    replayed,
  }
}

/** Refuses a body over `maxSize` bytes before it is parsed. */
export function usageBodyLimit(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: () => {
      throw new UnpriceApiError({
        code: "PAYLOAD_TOO_LARGE",
        message: `Request body must be ${maxSize} bytes or less`,
      })
    },
  })
}
