import { describe, expect, it } from "vitest"
import { buildCustomerEconomicSummary } from "./get-economic-summary"

describe("buildCustomerEconomicSummary", () => {
  it("maps invoice counts into the dashboard read model", () => {
    expect(
      buildCustomerEconomicSummary({
        customerId: "cus_123",
        totalInvoices: 4,
        paidInvoices: 3,
      })
    ).toEqual({
      customerId: "cus_123",
      invoiceCounts: { total: 4, paid: 3 },
    })
  })
})
