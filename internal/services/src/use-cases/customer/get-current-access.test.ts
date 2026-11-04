import type { Database } from "@unprice/db"
import type { BillingConfig, MeterConfig, ResetConfig } from "@unprice/db/validators"
import { Err, FetchError, Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { computeGrantPeriodBucket } from "../../entitlements"
import {
  type CurrentEntitlementsReader,
  type GetCustomerCurrentAccessDeps,
  getCustomerCurrentAccess,
} from "./get-current-access"

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

const _resetEveryFifteenMinutes = {
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

const _billingEveryFifteenMinutes = {
  name: "every-15-minutes",
  billingInterval: "minute",
  billingIntervalCount: 15,
  billingAnchor: "dayOfCreation",
  planType: "recurring",
} satisfies BillingConfig

describe("getCustomerCurrentAccess", () => {
  it("takes metered usage and its window live from the payer budget", async () => {
    const events = usageEntitlement({
      featureSlug: "events",
      featureTitle: "Events",
      grantId: "g_e",
    })
    const customers = usageEntitlement({
      id: "ce_customers",
      featureSlug: "customers",
      featureTitle: "Customers",
      grantId: "g_c",
    })
    const reader = vi.fn<CurrentEntitlementsReader>(async () =>
      Ok({
        customerId,
        generatedAt: now,
        entitlements: [
          {
            ...liveBase("ce_events", "events"),
            status: "available" as const,
            allowed: true,
            limit: 10_000,
            usage: 42,
            quotaWindow: { periodKey: "lim_events", startAt: cycleStart, endAt: null },
          },
          { ...liveBase("ce_customers", "customers"), status: "unavailable" as const },
        ],
      })
    )
    const { deps } = makeDeps({ entitlements: [events, customers], currentEntitlements: reader })

    const result = await getCustomerCurrentAccess(deps, { projectId, customerId })

    expect(reader).toHaveBeenCalledWith({ projectId, customerId })
    expect(result.val?.usageUnavailable).toBe(false)
    const byslug = new Map(result.val?.entitlements.map((row) => [row.featureSlug, row]))
    expect(byslug.get("events")).toMatchObject({
      currentUsage: 42,
      usagePercent: 0.42,
      usagePeriods: [{ periodKey: "lim_events", start: cycleStart, end: Number.MAX_SAFE_INTEGER }],
    })
    // Not answered live: no usage, and the grant's own period stays.
    const customersPeriod = computeGrantPeriodBucket(
      {
        cadenceEffectiveAt: entitlementEffectiveAt,
        cadenceExpiresAt: null,
        effectiveAt: entitlementEffectiveAt,
        expiresAt: null,
        grantId: "g_c",
        resetConfig: resetEveryFiveMinutes,
      },
      now
    )
    expect(byslug.get("customers")).toMatchObject({
      currentUsage: null,
      usagePeriods: [
        {
          periodKey: customersPeriod?.periodKey,
          start: customersPeriod?.start,
          end: customersPeriod?.end,
        },
      ],
    })
  })

  it("marks usage unavailable when the live read fails or is not wired", async () => {
    const events = usageEntitlement({
      featureSlug: "events",
      featureTitle: "Events",
      grantId: "g_e",
    })
    const failing = makeDeps({
      entitlements: [events],
      currentEntitlements: async () => Err(new FetchError({ message: "api down", retry: true })),
    })
    const failed = await getCustomerCurrentAccess(failing.deps, { projectId, customerId })
    expect(failed.val?.usageUnavailable).toBe(true)
    expect(failed.val?.entitlements[0]?.currentUsage).toBeNull()
    expect(failing.deps.logger.error).toHaveBeenCalled()

    const unwired = await getCustomerCurrentAccess(makeDeps({ entitlements: [events] }).deps, {
      projectId,
      customerId,
    })
    expect(unwired.val?.usageUnavailable).toBe(true)
  })

  it("does not read live usage when no metered entitlement is active", async () => {
    const reader = vi.fn<CurrentEntitlementsReader>()
    const { deps } = makeDeps({ entitlements: [flatEntitlement()], currentEntitlements: reader })

    const result = await getCustomerCurrentAccess(deps, { projectId, customerId })

    expect(reader).not.toHaveBeenCalled()
    expect(result.val?.usageUnavailable).toBe(false)
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
  currentEntitlements,
}: {
  entitlements: unknown[]
  nowAt?: number
  subscription?: unknown
  currentEntitlements?: CurrentEntitlementsReader
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
  const logger = {
    error: vi.fn(),
  }

  return {
    deps: {
      db,
      logger,
      ...(currentEntitlements && { currentEntitlements }),
      now: () => nowAt,
    } satisfies GetCustomerCurrentAccessDeps,
  }
}

function liveBase(id: string, featureSlug: string) {
  return {
    id,
    featureSlug,
    featureTitle: featureSlug,
    featureType: "usage" as const,
    unitOfMeasure: "unit",
    grantCount: 1,
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
