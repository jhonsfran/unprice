import { describe, expect, it } from "vitest"
import { spendingOf, unitCurrency } from "./index"

describe("budget unit spending", () => {
  it("recognizes supported money units only", () => {
    expect(
      ["money:USD", "money:EUR", "credits:tokens", "money:usd", "money:GBP", "money:"].map(
        unitCurrency
      )
    ).toEqual(["USD", "EUR", null, null, null, null])
  })
  it("keeps exact signed amounts and existing display precision", () => {
    expect(spendingOf(BigInt(-123456789), "money:USD")).toEqual({
      amount: "-1.23456789",
      currency: "USD",
      displayAmount: "-$1.235",
    })
    expect(
      spendingOf(BigInt(100000000), "money:USD", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    ).toEqual({ amount: "1", currency: "USD", displayAmount: "$1.00" })
  })
  it("keeps non-money units in display values", () => {
    expect(spendingOf(BigInt(250000000), "credits:tokens")).toEqual({
      amount: "2.5",
      currency: "XXX",
      displayAmount: "2.5 credits:tokens",
    })
  })
})
