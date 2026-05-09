import { describe, expect, it } from "vitest"

import { customerEntitlementInsertSchema } from "./entitlements"

const baseCustomerEntitlement = {
  projectId: "project_123",
  customerId: "customer_123",
  featurePlanVersionId: "plan_feature_123",
  subscriptionId: "subscription_123",
  subscriptionPhaseId: "subscription_phase_123",
  subscriptionItemId: "subscription_item_123",
  effectiveAt: 1_704_067_200_000,
}

describe("customerEntitlementInsertSchema", () => {
  it("rejects allowanceUnits because allowances belong to grants", () => {
    const result = customerEntitlementInsertSchema.safeParse({
      ...baseCustomerEntitlement,
      allowanceUnits: 10,
    })

    expect(result.success).toBe(false)
  })

  it("rejects stale entitlement override fields", () => {
    const result = customerEntitlementInsertSchema.safeParse({
      ...baseCustomerEntitlement,
      allowanceUnits: 10,
      anchor: 1,
      meterHash: "meter_hash_123",
      price: 100,
    })

    expect(result.success).toBe(false)
  })
})
