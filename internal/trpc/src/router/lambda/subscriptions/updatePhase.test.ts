import { describe, expect, it } from "vitest"
import { updatePhaseErrorToTrpcError } from "./updatePhase-errors"

describe("updatePhaseErrorToTrpcError", () => {
  it("keeps expected subscription phase failures customer-visible", () => {
    const error = updatePhaseErrorToTrpcError(
      Object.assign(new Error("Payment method is required for this plan version"), {
        name: "UnPriceSubscriptionError",
      })
    )

    expect(error.code).toBe("PRECONDITION_FAILED")
    expect(error.message).toContain("Payment method is required")
  })

  it("maps schema failures to bad request", () => {
    const error = updatePhaseErrorToTrpcError(
      Object.assign(new Error("End date must be after the phase start date"), {
        name: "SchemaError",
      })
    )

    expect(error.code).toBe("BAD_REQUEST")
  })

  it("keeps unknown failures internal", () => {
    const error = updatePhaseErrorToTrpcError(
      Object.assign(new Error("database failed"), {
        name: "FetchError",
      })
    )

    expect(error.code).toBe("INTERNAL_SERVER_ERROR")
  })

  it("keeps unexpected subscription failures internal", () => {
    const error = updatePhaseErrorToTrpcError(
      Object.assign(new Error("database failed"), {
        name: "UnPriceSubscriptionError",
      })
    )

    expect(error.code).toBe("INTERNAL_SERVER_ERROR")
  })
})
