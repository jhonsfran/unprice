import {
  getCustomerCurrentAccessOutputSchema,
  getCustomerCurrentEntitlementsOutputSchema,
} from "@unprice/services/use-cases"
import { describe, expect, it } from "vitest"
import { mergeCurrentEntitlements } from "./merge-current-entitlements"

const access = getCustomerCurrentAccessOutputSchema.parse({
  customerId: "cus_123",
  generatedAt: 100,
  activePlan: null,
  activeSubscriptionCount: 1,
  entitlementCount: 2,
  usageUnavailable: true,
  usageWindow: null,
  entitlements: [
    {
      id: "ce_tokens",
      featureSlug: "tokens",
      featureTitle: "Tokens",
      featureType: "usage",
      meterConfig: {
        eventSlug: "tokens.used",
        aggregationMethod: "sum",
        aggregationField: "tokens",
      },
      unitOfMeasure: "token",
      limit: 1_000,
      currentUsage: 0,
      usagePeriods: [],
      usagePercent: 0,
      grantCount: 1,
      grantAllowance: 1_000,
      subscriptionId: "sub_123",
      overageStrategy: "reject",
    },
    {
      id: "ce_tools",
      featureSlug: "tools",
      featureTitle: "Tools",
      featureType: "flat",
      meterConfig: null,
      unitOfMeasure: "access",
      limit: 1,
      currentUsage: null,
      usagePeriods: [],
      usagePercent: null,
      grantCount: 1,
      grantAllowance: 1,
      subscriptionId: "sub_123",
      overageStrategy: "reject",
    },
  ],
})

describe("mergeCurrentEntitlements", () => {
  it("replaces analytics usage with the live entitlement-window state", () => {
    const current = getCustomerCurrentEntitlementsOutputSchema.parse({
      customerId: "cus_123",
      generatedAt: 200,
      entitlements: [
        {
          id: "ce_tokens",
          featureSlug: "tokens",
          featureTitle: "Tokens",
          featureType: "usage",
          unitOfMeasure: "token",
          grantCount: 1,
          status: "available",
          allowed: true,
          limit: 2_000,
          usage: 750,
          usagePercent: 37.5,
          quotaWindow: { periodKey: "month:2026-08", startAt: 10, endAt: 20 },
        },
        {
          id: "ce_tools",
          featureSlug: "tools",
          featureTitle: "Tools",
          featureType: "flat",
          unitOfMeasure: "access",
          grantCount: 1,
          status: "available",
          allowed: true,
          limit: 1,
        },
      ],
    })

    const result = mergeCurrentEntitlements(access, current)

    expect(result.access.generatedAt).toBe(200)
    expect(result.access.usageUnavailable).toBe(false)
    expect(result.access.entitlements[0]).toMatchObject({
      currentUsage: 750,
      limit: 2_000,
      usagePercent: 37.5,
      usagePeriods: [{ periodKey: "month:2026-08", start: 10, end: 20 }],
    })
    expect(result.unavailableEntitlementIds.size).toBe(0)
  })

  it("marks only failed or missing usage entitlements unavailable", () => {
    const current = getCustomerCurrentEntitlementsOutputSchema.parse({
      customerId: "cus_123",
      generatedAt: 200,
      entitlements: [
        {
          id: "ce_tools",
          featureSlug: "tools",
          featureTitle: "Tools",
          featureType: "flat",
          unitOfMeasure: "access",
          grantCount: 1,
          status: "available",
          allowed: true,
          limit: 1,
        },
      ],
    })

    const result = mergeCurrentEntitlements(access, current)

    expect([...result.unavailableEntitlementIds]).toEqual(["ce_tokens"])
    expect(result.access.entitlements[1]?.limit).toBe(1)
  })
})
