import { describe, expect, it } from "vitest"
import {
  classifyInvoiceLineSettlement,
  mapWalletFundingToSettlement,
  summarizeInvoiceSettlementAmounts,
} from "./invoice-settlement"

describe("invoice settlement", () => {
  it("classifies provider lines as due", () => {
    expect(classifyInvoiceLineSettlement({ amount: 1_000, metadata: {} })).toMatchObject({
      amountDue: 1_000,
      amountIncluded: 0,
      amountPaid: 0,
      collectable: true,
      settlementSource: "provider",
      settlementStatus: "due",
    })
  })

  it("classifies credit-line wallet funding as due", () => {
    expect(mapWalletFundingToSettlement({ source: "granted", grantSource: "credit_line" })).toEqual(
      {
        collectable: true,
        invoiceVisibleCapture: false,
        settlementSource: "credit_line",
        settlementStatus: "due",
      }
    )
  })

  it("classifies purchased wallet funding as paid", () => {
    expect(mapWalletFundingToSettlement({ source: "purchased", grantSource: null })).toEqual({
      collectable: false,
      invoiceVisibleCapture: true,
      settlementSource: "cash_wallet",
      settlementStatus: "paid",
    })
  })

  it("classifies included wallet credits as included", () => {
    for (const grantSource of ["plan_included", "trial", "promo", "manual"] as const) {
      expect(mapWalletFundingToSettlement({ source: "granted", grantSource })).toEqual({
        collectable: false,
        invoiceVisibleCapture: true,
        settlementSource: grantSource,
        settlementStatus: "included",
      })
    }
  })

  it("summarizes header totals from classified lines", () => {
    expect(
      summarizeInvoiceSettlementAmounts([
        { amount: 10_000, metadata: {} },
        { amount: 4_000, metadata: { settlement_source: "credit_line" } },
        { amount: 1_500, metadata: { settlement_source: "cash_wallet" } },
        { amount: 2_500, metadata: { settlement_source: "plan_included" } },
      ])
    ).toEqual({
      amountDue: 14_000,
      amountIncluded: 2_500,
      amountPaid: 1_500,
      grossAmount: 18_000,
    })
  })
})
