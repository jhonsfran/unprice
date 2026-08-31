import type { FeatureUsagePeriodRow } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { BillingConfig, MeterConfig, ResetConfig } from "@unprice/db/validators"
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

const resetEveryFifteenMinutes = {
  name: "every-15-minutes",
  resetInterval: "minute",
  resetIntervalCount: 15,
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

const billingEveryFifteenMinutes = {
  name: "every-15-minutes",
  billingInterval: "minute",
  billingIntervalCount: 15,
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
      now
    )?.periodKey

    expect(expectedPeriodKey).toBeDefined()

    const { deps, analytics } = makeDeps({
      entitlements: [events, customers],
      periodRowsByPeriodKey: new Map([
        [
          expectedPeriodKey!,
          [
            periodRow({ feature_slug: "events", usage: 42 }),
            periodRow({
              customer_entitlement_id: "ce_customers",
              feature_slug: "customers",
              usage: 7,
            }),
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
      result.val?.entitlements.find((entitlement) => entitlement.featureSlug === "events")
        ?.meterConfig
    ).toEqual({
      eventSlug: "events_used",
      aggregationMethod: "sum",
      aggregationField: "quantity",
    })
    expect(
      result.val?.entitlements.find((entitlement) => entitlement.featureSlug === "customers")
        ?.currentUsage
    ).toBe(7)
    expect(
      result.val?.entitlements.find((entitlement) => entitlement.featureSlug === "customers")
        ?.usagePeriods
    ).toEqual([
      expect.objectContaining({
        periodKey: expectedPeriodKey,
      }),
    ])
  })

  it("loads each usage entitlement by its own current reset period", async () => {
    const currentNow = Date.parse("2026-06-30T21:09:45.000Z")
    const events = usageEntitlement({
      featureSlug: "events",
      featureTitle: "Events",
      grantId: "grant_events",
      resetConfig: resetEveryFiveMinutes,
      billingConfig: billingEveryFiveMinutes,
    })
    const customers = usageEntitlement({
      id: "ce_customers",
      featureSlug: "customers",
      featureTitle: "Customers",
      grantId: "grant_customers",
      resetConfig: resetEveryFifteenMinutes,
      billingConfig: billingEveryFifteenMinutes,
    })
    const eventsPeriod = computeGrantPeriodBucket(
      {
        cadenceEffectiveAt: entitlementEffectiveAt,
        cadenceExpiresAt: null,
        effectiveAt: entitlementEffectiveAt,
        expiresAt: null,
        grantId: "grant_events",
        resetConfig: resetEveryFiveMinutes,
      },
      currentNow
    )
    const customersPeriod = computeGrantPeriodBucket(
      {
        cadenceEffectiveAt: entitlementEffectiveAt,
        cadenceExpiresAt: null,
        effectiveAt: entitlementEffectiveAt,
        expiresAt: null,
        grantId: "grant_customers",
        resetConfig: resetEveryFifteenMinutes,
      },
      currentNow
    )

    expect(eventsPeriod).toBeDefined()
    expect(customersPeriod).toBeDefined()
    expect(eventsPeriod?.periodKey).not.toBe(customersPeriod?.periodKey)

    const { deps, analytics } = makeDeps({
      entitlements: [events, customers],
      nowAt: currentNow,
      periodRowsByPeriodKey: new Map([
        [eventsPeriod!.periodKey, [periodRow({ feature_slug: "events", usage: 4 })]],
        [
          customersPeriod!.periodKey,
          [
            periodRow({
              customer_entitlement_id: "ce_customers",
              feature_slug: "customers",
              usage: 9,
            }),
          ],
        ],
      ]),
    })

    const result = await getCustomerCurrentAccess(deps, { projectId, customerId })

    expect(result.err).toBeUndefined()
    expect(analytics.getFeaturesUsagePeriod).toHaveBeenCalledTimes(2)
    expect(analytics.getFeaturesUsagePeriod).toHaveBeenCalledWith({
      project_id: projectId,
      customer_id: customerId,
      period_key: eventsPeriod!.periodKey,
      feature_slugs: ["events"],
    })
    expect(analytics.getFeaturesUsagePeriod).toHaveBeenCalledWith({
      project_id: projectId,
      customer_id: customerId,
      period_key: customersPeriod!.periodKey,
      feature_slugs: ["customers"],
    })

    expect(
      result.val?.entitlements.find((entitlement) => entitlement.featureSlug === "events")
    ).toEqual(
      expect.objectContaining({
        currentUsage: 4,
        usagePeriods: [
          {
            periodKey: eventsPeriod!.periodKey,
            start: eventsPeriod!.start,
            end: eventsPeriod!.end,
          },
        ],
      })
    )
    expect(
      result.val?.entitlements.find((entitlement) => entitlement.featureSlug === "customers")
    ).toEqual(
      expect.objectContaining({
        currentUsage: 9,
        usagePeriods: [
          {
            periodKey: customersPeriod!.periodKey,
            start: customersPeriod!.start,
            end: customersPeriod!.end,
          },
        ],
      })
    )
  })

  it("uses the active entitlement period even when the subscription cycle has not advanced", async () => {
    const events = usageEntitlement({
      featureSlug: "events",
      featureTitle: "Events",
      grantId: "grant_events",
    })
    const expectedPeriod = computeGrantPeriodBucket(
      {
        cadenceEffectiveAt: entitlementEffectiveAt,
        cadenceExpiresAt: null,
        effectiveAt: entitlementEffectiveAt,
        expiresAt: null,
        grantId: "grant_events",
        resetConfig: resetEveryFiveMinutes,
      },
      now
    )

    expect(expectedPeriod).toBeDefined()

    const { deps, analytics } = makeDeps({
      entitlements: [events],
      subscription: {
        ...activeSubscription(),
        currentCycleStartAt: Date.parse("2026-06-30T20:45:57.000Z"),
        currentCycleEndAt: Date.parse("2026-06-30T21:00:57.000Z"),
        renewAt: Date.parse("2026-06-30T21:00:57.000Z"),
      },
      periodRowsByPeriodKey: new Map([
        [expectedPeriod!.periodKey, [periodRow({ feature_slug: "events", usage: 12 })]],
      ]),
    })

    const result = await getCustomerCurrentAccess(deps, { projectId, customerId })

    expect(result.err).toBeUndefined()
    expect(analytics.getFeaturesUsagePeriod).toHaveBeenCalledWith({
      project_id: projectId,
      customer_id: customerId,
      period_key: expectedPeriod!.periodKey,
      feature_slugs: ["events"],
    })
    expect(
      result.val?.entitlements.find((entitlement) => entitlement.featureSlug === "events")
        ?.currentUsage
    ).toBe(12)
  })

  it("does not add usage from an expired entitlement with the same feature and reset period", async () => {
    const events = usageEntitlement({
      featureSlug: "events",
      featureTitle: "Events",
      grantId: "grant_events",
    })
    const expectedPeriod = computeGrantPeriodBucket(
      {
        cadenceEffectiveAt: entitlementEffectiveAt,
        cadenceExpiresAt: null,
        effectiveAt: entitlementEffectiveAt,
        expiresAt: null,
        grantId: "grant_events",
        resetConfig: resetEveryFiveMinutes,
      },
      now
    )

    expect(expectedPeriod).toBeDefined()

    const { deps } = makeDeps({
      entitlements: [events],
      periodRowsByPeriodKey: new Map([
        [
          expectedPeriod!.periodKey,
          [
            periodRow({ customer_entitlement_id: "ce_events", usage: 2 }),
            periodRow({ customer_entitlement_id: "ce_expired_events", usage: 3 }),
          ],
        ],
      ]),
    })

    const result = await getCustomerCurrentAccess(deps, { projectId, customerId })

    expect(result.err).toBeUndefined()
    expect(result.val?.entitlements[0]?.currentUsage).toBe(2)
  })

  it("does not call usage analytics when no measured usage entitlement is active", async () => {
    const { deps, analytics } = makeDeps({
      entitlements: [flatEntitlement()],
    })

    const result = await getCustomerCurrentAccess(deps, { projectId, customerId })

    expect(result.err).toBeUndefined()
    expect(analytics.getFeaturesUsagePeriod).not.toHaveBeenCalled()
    expect(result.val?.entitlements[0]?.currentUsage).toBeNull()
    expect(result.val?.entitlements[0]?.meterConfig).toBeNull()
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

  it.each(["tier", "package"])(
    "uses the subscribed grant quantity for %s entitlements",
    async (featureType) => {
      const entitlement = usageEntitlement({
        featureSlug: "plans",
        featureTitle: "Plans",
        grantId: "grant_plans",
        grantAllowances: [10],
        limit: 10_000,
      })
      entitlement.featurePlanVersion.featureType = featureType
      entitlement.featurePlanVersion.meterConfig = null

      const { deps } = makeDeps({ entitlements: [entitlement] })
      const result = await getCustomerCurrentAccess(deps, { projectId, customerId })

      expect(result.err).toBeUndefined()
      expect(result.val?.entitlements[0]).toEqual(
        expect.objectContaining({
          featureType,
          grantAllowance: 10,
          limit: 10,
          currentUsage: null,
        })
      )
    }
  )
})

function makeDeps({
  entitlements,
  nowAt = now,
  subscription = activeSubscription(),
  periodRowsByPeriodKey = new Map<string, FeatureUsagePeriodRow[]>(),
}: {
  entitlements: unknown[]
  nowAt?: number
  subscription?: unknown
  periodRowsByPeriodKey?: Map<string, FeatureUsagePeriodRow[]>
}) {
  const db = {
    query: {
      customers: {
        findFirst: vi.fn(async () => ({ id: customerId })),
      },
      subscriptions: {
        findMany: vi.fn(async () => [subscription]),
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
      now: () => nowAt,
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
        paymentMethodId: "pm_phase_1",
        creditLinePolicy: "uncapped",
        creditLineAmount: null,
        paymentProvider: "sandbox",
        startAt: entitlementEffectiveAt,
        endAt: null,
        planVersion: {
          id: "pv_1",
          version: 1,
          billingConfig: billingEveryFiveMinutes,
        },
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
  meterConfig = {
    eventId: `evt_${featureSlug}`,
    eventSlug: `${featureSlug}_used`,
    aggregationMethod: "sum",
    aggregationField: "quantity",
  },
  resetConfig = resetEveryFiveMinutes,
  billingConfig = billingEveryFiveMinutes,
}: {
  id?: string
  featureSlug: string
  featureTitle: string
  grantAllowances?: Array<number | null>
  grantId: string
  limit?: number | null
  meterConfig?: MeterConfig | null
  resetConfig?: ResetConfig | null
  billingConfig?: BillingConfig
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
      meterConfig,
      resetConfig,
      billingConfig,
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
    customer_entitlement_id: "ce_events",
    feature_slug: "events",
    usage: 1,
    amount_after: 0,
    currency: "USD",
    ...overrides,
  }
}
