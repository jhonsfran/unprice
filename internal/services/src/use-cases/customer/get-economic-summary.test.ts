import { describe, expect, it } from "vitest"
import { buildCustomerEconomicSummary } from "./get-economic-summary"

describe("buildCustomerEconomicSummary", () => {
  it("maps run and invoice counts into the dashboard read model", () => {
    expect(
      buildCustomerEconomicSummary({
        customerId: "cus_123",
        totalRuns: 9,
        runningRuns: 2,
        budgetExceededRuns: 1,
        totalInvoices: 4,
        paidInvoices: 3,
      })
    ).toEqual({
      customerId: "cus_123",
      runCounts: { total: 9, running: 2, budgetExceeded: 1 },
      invoiceCounts: { total: 4, paid: 3 },
    })
  })
})
