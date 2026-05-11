import { describe, expect, it } from "vitest"
import { paymentProviderContractSuites } from "./contract-cases"
import { definePaymentProviderContractTests } from "./contract-suite"
import { ACTIVE_PAYMENT_PROVIDERS } from "./service"

describe("active payment provider contract coverage", () => {
  it("has one contract suite for every active payment provider", () => {
    expect(Object.keys(paymentProviderContractSuites).sort()).toEqual(
      [...ACTIVE_PAYMENT_PROVIDERS].sort()
    )
  })
})

for (const suite of Object.values(paymentProviderContractSuites)) {
  definePaymentProviderContractTests(suite)
}
