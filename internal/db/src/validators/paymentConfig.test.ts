import { describe, expect, it } from "vitest"
import { insertPaymentProviderConfigSchema } from "./paymentConfig"

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
})
