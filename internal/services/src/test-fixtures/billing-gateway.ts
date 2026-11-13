import type { RateRow } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import { vi } from "vitest"
import type { InvoicingPorts } from "../billing/invoicing-ports"
import type { DbExecutor } from "../deps"
import { ModelCostService } from "../model-costs/service"
import { RateCardService } from "../rate-cards/service"
import type { PayerBudgetGateway } from "../use-cases/budgets/payer-budget-gateway"

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
 * Invoicing with a no-op payer-budget gateway. With `rows` the plan prices recurring items from a USD card
 * holding them; without, the plan has no card and nothing recurring is priced.
 */
export function createInvoicingStub(opts: { rows?: RateRow[]; currency?: string } = {}) {
  const currency = opts.currency ?? "USD"
  return {
    payerBudgets: noopPayerBudgetGateway(),
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
      rowsForVersions: vi.fn(
        async (_projectId: string, versions: readonly { id: string }[]) =>
          new Map(versions.map((version) => [version.id, opts.rows ?? []]))
      ),
    },
  } satisfies InvoicingPorts
}

/** Invoicing tests that do not exercise BudgetDO still use the production gateway contract. */
export function noopPayerBudgetGateway(): PayerBudgetGateway {
  return {
    sync: async ({ customerId }) =>
      Ok({
        status: "synced",
        key: `unprice:customer:${customerId}`,
        version: 1,
        changes: [],
        statements: 0,
      }),
    seal: async () => Ok({ sealed: [], open: [] }),
    completeInvoiced: async () => Ok({ completed: [] }),
  }
}

/** Real card and model-cost services, with an explicit payer-budget test port. */
export function testInvoicing({
  db,
  payerBudgets = noopPayerBudgetGateway(),
}: {
  db: DbExecutor
  payerBudgets?: PayerBudgetGateway
}) {
  return {
    payerBudgets,
    rateCards: new RateCardService({ db, modelCosts: new ModelCostService({ db }) }),
  }
}
