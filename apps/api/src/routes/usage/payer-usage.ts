import type { UsageEventResult } from "@unprice/db/validators"
import {
  type MeterPayerUsageDeps,
  type PayerUsageResult,
  rateCardSource,
  walletFunding,
} from "@unprice/services/use-cases"
import type { Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { CloudflareBudgetClient } from "~/ingestion/budget/client"
import { journalOf } from "~/ingestion/budget/journal"
import { amountToWire, budgetRejectionError } from "../budgets/budget-verb"

/**
 * What `meterPayerUsage` needs in the API worker: the payer budget's Durable Object reached
 * directly (billing's compile created it; a usage call never defines it), the card source and
 * wallet for a refresh or a prepaid reserve, and the journal stream for refused events.
 */
export function payerUsageDeps(c: Context<HonoEnv>): MeterPayerUsageDeps {
  const { budgetCatalog, rateCards, wallet } = c.get("services")
  return {
    budgets: new CloudflareBudgetClient(c.env),
    cards: rateCardSource(rateCards),
    wallet: walletFunding(wallet),
    services: { budgetCatalog },
    logger: c.get("logger"),
    waitUntil: c.get("waitUntil"),
    journal: journalOf(c.env),
  }
}

/** One event's answer in a batch: what it cost, or the error a single call would have returned. */
export function usageResultToWire({ event, result }: PayerUsageResult): UsageEventResult {
  const { customerId, idempotencyKey } = event
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
