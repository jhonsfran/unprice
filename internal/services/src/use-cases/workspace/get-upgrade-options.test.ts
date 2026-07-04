import { FetchError } from "@unprice/error"
import { describe, expect, it } from "vitest"
import { UnPriceCustomerError } from "../../customers/errors"
import { isMissingDefaultPaymentMethodError } from "./get-upgrade-options"

describe("isMissingDefaultPaymentMethodError", () => {
  it("treats known default-payment absence messages as non-fatal", () => {
    expect(
      isMissingDefaultPaymentMethodError(
        new FetchError({
          message: "Required payment method not found",
          retry: false,
        })
      )
    ).toBe(true)

    expect(
      isMissingDefaultPaymentMethodError(new Error("Customer payment provider id not set"))
    ).toBe(true)

    expect(isMissingDefaultPaymentMethodError(new Error("No payment methods found"))).toBe(true)
  })

  it("keeps unrelated provider and customer failures fatal", () => {
    expect(
      isMissingDefaultPaymentMethodError(
        new FetchError({
          message: "Stripe is disabled for this project.",
          retry: false,
        })
      )
    ).toBe(false)

    expect(
      isMissingDefaultPaymentMethodError(
        new UnPriceCustomerError({
          code: "CUSTOMER_NOT_FOUND",
          message: "Customer not found",
        })
      )
    ).toBe(false)

    expect(isMissingDefaultPaymentMethodError("No payment methods found")).toBe(false)
  })
})
