import { describe, expect, it } from "vitest"
import { UnPriceBillingError } from "./errors"

describe("UnPriceBillingError", () => {
  it("preserves the supplied stable code, message, and context", () => {
    const error = new UnPriceBillingError({
      code: "INVOICE_PAYMENT_METHOD_MISSING",
      message: "Invoice requires a payment method, please set a payment method first",
      context: { invoiceId: "inv_123" },
    })

    expect(error.code).toBe("INVOICE_PAYMENT_METHOD_MISSING")
    expect(error.message).toBe(
      "Invoice requires a payment method, please set a payment method first"
    )
    expect(error.context).toEqual({ invoiceId: "inv_123" })
  })
})
