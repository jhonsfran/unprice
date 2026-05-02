import { describe, expect, it } from "vitest"
import { DEFAULT_GRANT_PRIORITY } from "../entitlements/grants"

describe("SubscriptionService entitlement grant provisioning contract", () => {
  it("uses subscription grants as the default allowance chunk", () => {
    expect(DEFAULT_GRANT_PRIORITY.subscription).toBe(10)
  })
})
