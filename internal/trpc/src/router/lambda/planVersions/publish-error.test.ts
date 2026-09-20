import { describe, expect, it } from "vitest"
import { getPublicTrpcErrorMessage } from "../../../error-format"
import { paymentProviderPublishError } from "./publish-error"

describe("plan version publish error mapping", () => {
  it("keeps missing payment provider configuration customer-visible", () => {
    const error = paymentProviderPublishError()

    expect(error.code).toBe("PRECONDITION_FAILED")
    expect(
      getPublicTrpcErrorMessage({
        code: error.code,
        message: error.message,
      })
    ).toBe(
      "The plan's payment provider is not configured or enabled. Configure it in payment settings before publishing this paid plan."
    )
  })
})
