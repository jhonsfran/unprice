import { describe, expect, it } from "vitest"
import { UnPriceSubscriptionError } from "./errors"

describe("UnPriceSubscriptionError", () => {
  it("preserves the supplied stable code, message, and context", () => {
    const error = new UnPriceSubscriptionError({
      code: "PHASE_OVERLAP",
      message: "Phases overlap, there is already a phase in the same date range",
      context: { subscriptionId: "sub_123" },
    })

    expect(error.code).toBe("PHASE_OVERLAP")
    expect(error.message).toBe("Phases overlap, there is already a phase in the same date range")
    expect(error.context).toEqual({ subscriptionId: "sub_123" })
  })
})
