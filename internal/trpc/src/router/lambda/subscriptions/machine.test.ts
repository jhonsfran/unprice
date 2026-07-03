import { describe, expect, it } from "vitest"
import { toSubscriptionMachineTrpcError } from "./machine-errors"

describe("toSubscriptionMachineTrpcError", () => {
  it("keeps early renew denials customer-visible", () => {
    const error = toSubscriptionMachineTrpcError({
      message: "Cannot renew subscription, subscription  will be renewed at 7/3/2026, 2:45:42 PM",
    })

    expect(error.code).toBe("PRECONDITION_FAILED")
    expect(error.message).toContain("Cannot renew subscription")
  })

  it("maps lock contention to conflict", () => {
    const error = toSubscriptionMachineTrpcError({ message: "SUBSCRIPTION_BUSY" })

    expect(error.code).toBe("CONFLICT")
    expect(error.message).toBe("Subscription is already being updated")
  })

  it("keeps invoice precondition denials customer-visible", () => {
    const error = toSubscriptionMachineTrpcError({
      message: "Cannot invoice wallet-only subscription (BILL phase is skipped)",
    })

    expect(error.code).toBe("PRECONDITION_FAILED")
  })

  it("keeps unknown failures internal", () => {
    const error = toSubscriptionMachineTrpcError({ message: "database failed" })

    expect(error.code).toBe("INTERNAL_SERVER_ERROR")
  })
})
