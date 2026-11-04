import type { RateRow } from "@unprice/db/validators"
import { vi } from "vitest"
import type { InvoicingPorts } from "../use-cases/billing/bill-period"

/** A recurring flat row on the plan card: `amount` in currency units, e.g. "99". */
export function flatRateRow(featureSlug: string, amount: string): RateRow {
  const [whole = "0", fraction = ""] = amount.split(".")
  return {
    id: `row_${featureSlug}`,
    rateCardId: "card_test",
    featureSlug,
    match: {},
    price: { type: "flat", amount: BigInt(whole + fraction.padEnd(8, "0")) },
    cost: null,
    effectiveFrom: 0,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
  }
}

/**
 * Invoicing without a payer budget. With `rows` the plan prices recurring items from a USD card
 * holding them; without, the plan has no card and nothing recurring is priced.
 */
export function createInvoicingStub(opts: { rows?: RateRow[]; currency?: string } = {}) {
  const currency = opts.currency ?? "USD"
  return {
    payerBudgets: null,
    rateCards: {
      cardForPlanVersion: vi.fn(async (_projectId: string, planVersionId: string) =>
        opts.rows
          ? {
              planVersionId,
              currency: currency as "USD",
              cardId: "card_test",
              unit: `money:${currency}`,
            }
          : null
      ),
      getEffectiveRows: vi.fn(async () => opts.rows ?? []),
    },
  } satisfies InvoicingPorts
}
