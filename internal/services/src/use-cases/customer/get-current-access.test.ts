import type { FeatureUsagePeriodRow } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { BillingConfig, ResetConfig } from "@unprice/db/validators"
import { describe, expect, it, vi } from "vitest"
import { computeGrantPeriodBucket } from "../../entitlements"
import { type GetCustomerCurrentAccessDeps, getCustomerCurrentAccess } from "./get-current-access"

const projectId = "proj_1"
const customerId = "cus_1"
const entitlementEffectiveAt = Date.parse("2026-06-22T12:37:57.702Z")
const cycleStart = Date.parse("2026-06-30T21:00:57.000Z")
const cycleEnd = Date.parse("2026-06-30T21:15:57.000Z")
const now = Date.parse("2026-06-30T21:04:45.000Z")

const resetEveryFiveMinutes = {
  name: "every-5-minutes",
  resetInterval: "minute",
  resetIntervalCount: 5,
  resetAnchor: "dayOfCreation",
  planType: "recurring",
} satisfies ResetConfig

const billingEveryFiveMinutes = {
  name: "every-5-minutes",
  billingInterval: "minute",
  billingIntervalCount: 5,
  billingAnchor: "dayOfCreation",
  planType: "recurring",
} satisfies BillingConfig

describe("getCustomerCurrentAccess", () => {
  it("loads active entitlement usage by entitlement period key, not exact cycle timestamps", async () => {
    const events = usageEntitlement({
      featureSlug: "events",
      featureTitle: "Events",
      grantId: "grant_events",
    })
    const customers = usageEntitlement({
      id: "ce_customers",
      featureSlug: "customers",
      featureTitle: "Customers",
      grantId: "grant_customers",
    })
    const expectedPeriodKey = computeGrantPeriodBucket(
      {
        cadenceEffectiveAt: entitlementEffectiveAt,
        cadenceExpiresAt: null,
        effectiveAt: entitlementEffectiveAt,
        expiresAt: null,
        grantId: "grant_events",
        resetConfig: resetEveryFiveMinutes,
      },
      now - 1
    )?.periodKey

    expect(expectedPeriodKey).toBeDefined()

    const { deps, analytics } = makeDeps({
      entitlements: [events, customers],
      periodRowsByPeriodKey: new Map([
        [
          expectedPeriodKey!,
          [
            periodRow({ feature_slug: "events", usage: 42 }),
            periodRow({ feature_slug: "customers", usage: 7 }),
          ],
        ],
      ]),
    })

    const result = await getCustomerCurrentAccess(deps, { projectId, customerId })

    expect(result.err).toBeUndefined()
    expect(analytics.getFeaturesUsagePeriod).toHaveBeenCalledTimes(1)

    const call = analytics.getFeaturesUsagePeriod.mock.calls[0]?.[0]
    expect(call).toEqual({
      project_id: projectId,
      customer_id: customerId,
      period_key: expectedPeriodKey,
      feature_slugs: ["customers", "events"],
    })
    expect(call).not.toHaveProperty("start")
    expect(call).not.toHaveProperty("end")

    expect(
      result.val?.entitlements.find((entitlement) => entitlement.featureSlug === "events")
        ?.currentUsage
    ).toBe(42)
    expect(
      result.val?.entitlements.find((entitlement) => entitlement.featureSlug === "customers")
        ?.currentUsage
    ).toBe(7)
  })

  it("does not call usage analytics when no measured usage entitlement is active", async () => {
    const { deps, analytics } = makeDeps({
      entitlements: [flatEntitlement()],
    })

    const result = await getCustomerCurrentAccess(deps, { projectId, customerId })

    expect(result.err).toBeUndefined()
    expect(analytics.getFeaturesUsagePeriod).not.toHaveBeenCalled()
    expect(result.val?.entitlements[0]?.currentUsage).toBeNull()
  })

  it("treats any unlimited grant as unlimited allowance", async () => {
    const entitlement = usageEntitlement({
      featureSlug: "events",
      featureTitle: "Events",
      grantId: "grant_events",
      grantAllowances: [100, null],
      limit: null,
    })
    const { deps } = makeDeps({
      entitlements: [entitlement],
    })

    const result = await getCustomerCurrentAccess(deps, { projectId, customerId })

    expect(result.err).toBeUndefined()
    expect(result.val?.entitlements[0]).toEqual(
      expect.objectContaining({
        featureSlug: "events",
        grantAllowance: null,
        limit: null,
      })
    )
  })
})

function makeDeps({
  entitlements,
  periodRowsByPeriodKey = new Map<string, FeatureUsagePeriodRow[]>(),
}: {
  entitlements: unknown[]
  periodRowsByPeriodKey?: Map<string, FeatureUsagePeriodRow[]>
}) {
  const db = {
    query: {
      customers: {
        findFirst: vi.fn(async () => ({ id: customerId })),
      },
      subscriptions: {
        findMany: vi.fn(async () => [activeSubscription()]),
      },
      customerEntitlements: {
        findMany: vi.fn(async () => entitlements),
      },
    },
  } as unknown as Database
  const analytics = {
    getFeaturesUsagePeriod: vi.fn(
      async (
        params: Parameters<GetCustomerCurrentAccessDeps["analytics"]["getFeaturesUsagePeriod"]>[0]
      ) => ({
        data: periodRowsByPeriodKey.get(params.period_key ?? "") ?? [],
      })
    ),
  } satisfies GetCustomerCurrentAccessDeps["analytics"]
  const logger = {
    error: vi.fn(),
  }

  return {
    analytics,
    deps: {
      db,
      analytics,
      logger,
      now: () => now,
    } satisfies GetCustomerCurrentAccessDeps,
  }
}

function activeSubscription() {
  return {
    id: "sub_1",
    planSlug: "free",
    status: "active",
    currentCycleStartAt: cycleStart,
    currentCycleEndAt: cycleEnd,
    renewAt: cycleEnd,
    timezone: "UTC",
    phases: [
      {
        id: "phase_1",
        planVersionId: "pv_1",
        creditLinePolicy: "uncapped",
        creditLineAmount: null,
        startAt: entitlementEffectiveAt,
        endAt: null,
      },
    ],
  }
}

function usageEntitlement({
  id = "ce_events",
  featureSlug,
  featureTitle,
  grantAllowances = [10_000],
  grantId,
  limit = 10_000,
}: {
  id?: string
  featureSlug: string
  featureTitle: string
  grantAllowances?: Array<number | null>
  grantId: string
  limit?: number | null
}) {
  return {
    id,
    projectId,
    customerId,
    featurePlanVersionId: `fpv_${featureSlug}`,
    subscriptionId: "sub_1",
    subscriptionPhaseId: "phase_1",
    subscriptionItemId: `si_${featureSlug}`,
    effectiveAt: entitlementEffectiveAt,
    expiresAt: null,
    overageStrategy: "none",
    featurePlanVersion: {
      id: `fpv_${featureSlug}`,
      projectId,
      featureType: "usage",
      unitOfMeasure: featureSlug.slice(0, -1) || "unit",
      limit,
      meterConfig: { aggregationMethod: "count" },
      resetConfig: resetEveryFiveMinutes,
      billingConfig: billingEveryFiveMinutes,
      feature: {
        id: `feat_${featureSlug}`,
        slug: featureSlug,
        title: featureTitle,
      },
    },
    grants: grantAllowances.map((allowanceUnits, index) => ({
      id: grantAllowances.length === 1 ? grantId : `${grantId}_${index + 1}`,
      projectId,
      customerEntitlementId: id,
      type: "subscription",
      priority: 0,
      allowanceUnits,
      effectiveAt: entitlementEffectiveAt,
      expiresAt: null,
    })),
  }
}

function flatEntitlement() {
  return {
    ...usageEntitlement({
      id: "ce_access",
      featureSlug: "access-free",
      featureTitle: "Access Free",
      grantId: "grant_access",
    }),
    featurePlanVersion: {
      ...usageEntitlement({
        id: "ce_access",
        featureSlug: "access-free",
        featureTitle: "Access Free",
        grantId: "grant_access",
      }).featurePlanVersion,
      featureType: "flat",
      limit: null,
      meterConfig: null,
      unitOfMeasure: "access",
    },
    grants: [
      {
        id: "grant_access",
        projectId,
        customerEntitlementId: "ce_access",
        type: "subscription",
        priority: 0,
        allowanceUnits: 1,
        effectiveAt: entitlementEffectiveAt,
        expiresAt: null,
      },
    ],
  }
}

function periodRow(overrides: Partial<FeatureUsagePeriodRow>): FeatureUsagePeriodRow {
  return {
    project_id: projectId,
    customer_id: customerId,
    feature_slug: "events",
    usage: 1,
    amount_after: 0,
    currency: "USD",
    ...overrides,
  }
}
