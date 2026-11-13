import type { RateCardService } from "../rate-cards/service"
import type { PayerBudgetGateway } from "../use-cases/budgets/payer-budget-gateway"

/**
 * What invoicing reads besides the database (ADR-0008 D4): the payer budget, whose sealed
 * statements carry the usage it priced at ingestion, and the plan version's rate card, which
 * prices recurring items.
 */
export type InvoicingPorts = {
  payerBudgets: PayerBudgetGateway
  /** Also prices the credit line a period's activation derives from the plan's usage limits. */
  rateCards: Pick<RateCardService, "cardForPlanVersion" | "getEffectiveRows" | "rowsForVersions">
}
