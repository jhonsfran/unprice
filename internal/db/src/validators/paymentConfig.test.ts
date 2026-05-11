import { describe, expect, it } from "vitest"
import {
  insertPaymentProviderConfigSchema,
  paymentProviderConnectionDataSchema,
} from "./paymentConfig"

describe("payment provider config validators", () => {
  it("accepts managed connection configs without project-owned provider keys", () => {
    const parsed = insertPaymentProviderConfigSchema.parse({
      paymentProvider: "stripe",
      active: true,
      connectionType: "managed_connection",
      mode: "test",
      status: "pending",
      externalAccountId: "acct_123",
      key: null,
      keyIv: null,
    })

    expect(parsed.connectionType).toBe("managed_connection")
    expect(parsed.externalAccountId).toBe("acct_123")
    expect(parsed.key).toBeNull()
  })

  it("accepts Stripe Connect requirement errors for managed accounts", () => {
    const parsed = paymentProviderConnectionDataSchema.parse({
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: true,
      requirements: {
        currently_due: ["individual.first_name"],
        disabled_reason: "requirements.past_due",
        errors: [
          {
            code: "verification_failed_keyed_identity",
            reason:
              "The identity information could not be found. Review for accuracy and provide additional documentation to verify.",
            requirement: "individual.first_name",
          },
        ],
        past_due: ["individual.first_name"],
      },
      disabledReason: "requirements.past_due",
    })

    expect(parsed?.requirements?.errors?.[0]?.reason).toContain(
      "identity information could not be found"
    )
    expect(parsed?.requirements?.past_due).toEqual(["individual.first_name"])
  })
})
