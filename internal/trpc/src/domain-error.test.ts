import { SchemaError } from "@unprice/error"
import { UnPriceMachineError, UnPriceSubscriptionError } from "@unprice/services/subscriptions"
import { describe, expect, it } from "vitest"
import { domainErrorToTrpcError } from "#domain-error"

describe("domainErrorToTrpcError", () => {
  it("keeps machine precondition rejections customer-visible", () => {
    const error = domainErrorToTrpcError(
      new UnPriceMachineError({
        message: "Cannot renew subscription, subscription  will be renewed at 7/3/2026, 2:45:42 PM",
        kind: "precondition",
      })
    )

    expect(error.code).toBe("PRECONDITION_FAILED")
    expect(error.message).toContain("Cannot renew subscription")
  })

  it("maps lock contention to conflict and preserves the error message", () => {
    const error = domainErrorToTrpcError(
      new UnPriceSubscriptionError({
        code: "SUBSCRIPTION_BUSY",
        message: "Subscription is already being updated",
      })
    )

    expect(error.code).toBe("CONFLICT")
    expect(error.message).toBe("Subscription is already being updated")
  })

  it("keeps subscription precondition failures customer-visible", () => {
    const error = domainErrorToTrpcError(
      new UnPriceSubscriptionError({
        code: "PAYMENT_METHOD_REQUIRED",
        message: "Payment method is required for this plan version",
      })
    )

    expect(error.code).toBe("PRECONDITION_FAILED")
    expect(error.message).toContain("Payment method is required")
  })

  it("keeps inactive-customer subscription failures customer-visible", () => {
    const error = domainErrorToTrpcError(
      new UnPriceSubscriptionError({
        code: "CUSTOMER_NOT_ACTIVE",
        message: "This customer is inactive. Activate the customer before creating a subscription.",
      })
    )

    expect(error.code).toBe("PRECONDITION_FAILED")
    expect(error.message).toContain("This customer is inactive")
  })

  it("maps schema failures to bad request", () => {
    const error = domainErrorToTrpcError(
      new SchemaError({ message: "End date must be after the phase start date" })
    )

    expect(error.code).toBe("BAD_REQUEST")
  })

  it("keeps machine internal failures internal", () => {
    const error = domainErrorToTrpcError(new UnPriceMachineError({ message: "database failed" }))

    expect(error.code).toBe("INTERNAL_SERVER_ERROR")
  })

  it("keeps unexpected subscription failures internal", () => {
    const error = domainErrorToTrpcError(
      new UnPriceSubscriptionError({
        code: "SUBSCRIPTION_OPERATION_FAILED",
        message: "database failed",
      })
    )

    expect(error.code).toBe("INTERNAL_SERVER_ERROR")
  })

  it("keeps unknown failures internal", () => {
    const error = domainErrorToTrpcError(new Error("database failed"))

    expect(error.code).toBe("INTERNAL_SERVER_ERROR")
  })
})
