import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { PlanVersion } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BillingService } from "../billing/service"
import type { Cache } from "../cache/service"
import { CustomerService } from "../customers/service"
import { MemoryEntitlementStorageProvider } from "../entitlements/memory-provider"
import { EntitlementService } from "../entitlements/service"
import type { Metrics } from "../metrics"
import { SubscriptionService } from "../subscriptions/service"
import { createClock, createMockEntitlementState } from "../test-utils"
import { unprice } from "../utils/unprice"

vi.mock("../env", () => ({
  env: {
    ENCRYPTION_KEY: "test_encryption_key",
    NODE_ENV: "test",
  },
}))

vi.mock("../utils/unprice", () => ({
  unprice: {
    customers: {
      resetEntitlements: vi.fn().mockResolvedValue(Ok(undefined)),
    },
  },
}))

vi.mock("@unprice/db/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@unprice/db/utils")>()
  return {
    ...actual,
    AesGCM: {
      withBase64Key: vi.fn().mockResolvedValue({
        decrypt: vi.fn().mockResolvedValue("test_decrypted_key"),
      }),
    },
    newId: vi
      .fn()
      .mockImplementation((prefix) => `${prefix}_${Math.random().toString(36).substr(2, 9)}`),
  }
})

describe("Golden Scenario - Customer Journey", () => {
  let customerService: CustomerService
  let subscriptionService: SubscriptionService
  let entitlementService: EntitlementService
  let _billingService: BillingService

  let mockDb: Database
  let mockAnalytics: Analytics
  let mockCache: Cache
  let mockLogger: Logger
  let mockMetrics: Metrics
  let mockStorage: MemoryEntitlementStorageProvider

  const initialNow = new Date("2024-01-01T00:00:00Z").getTime()
  const clock = createClock(initialNow)
  const projectId = "proj_123"
  const customerId = "cust_123"
  const featureSlug = "api-requests"

  const mockPlanVersion = {
    id: "pv_123",
    status: "published",
    active: true,
    paymentMethodRequired: false,
    billingConfig: {
      name: "standard",
      billingInterval: "month",
      billingIntervalCount: 1,
      planType: "recurring",
      billingAnchor: 1,
    },
    plan: { id: "p_123", slug: "pro" },
    planFeatures: [
      {
        id: "pf_1",
        feature: { id: "f_1", slug: featureSlug },
        featureType: "usage",
        aggregationMethod: "sum",
        config: { usageMode: "sum" },
        billingConfig: {
          name: "standard",
          billingInterval: "month",
          billingIntervalCount: 1,
          planType: "recurring",
        },
        limit: 1000,
      },
    ],
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    clock.set(initialNow)

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    } as unknown as Logger

    mockAnalytics = {
      ingestFeaturesVerification: vi.fn().mockResolvedValue({ successful_rows: 1 }),
      ingestFeaturesUsage: vi.fn().mockResolvedValue({ successful_rows: 1 }),
      getFeaturesUsageCursor: vi
        .fn()
        .mockResolvedValue(Ok({ usage: 0, lastRecordId: "rec_initial" })),
      getBillingUsage: vi.fn().mockResolvedValue({ data: [] }),
    } as unknown as Analytics

    mockMetrics = {} as unknown as Metrics
    mockCache = {
      customerEntitlement: {
        swr: vi
          .fn()
          .mockImplementation(async (_key, fetcher) => ({ val: await fetcher(), fresh: true })),
        set: vi.fn(),
        get: vi.fn(),
        remove: vi.fn(),
      },
      customerEntitlements: {
        remove: vi.fn(),
        swr: vi
          .fn()
          .mockImplementation(async (_key, fetcher) => ({ val: await fetcher(), fresh: true })),
      },
      getCurrentUsage: {
        remove: vi.fn(),
      },
      accessControlList: {
        get: vi.fn().mockResolvedValue({ val: null }),
        set: vi.fn(),
        remove: vi.fn(),
      },
      negativeEntitlements: {
        get: vi.fn().mockResolvedValue({ val: null }),
        set: vi.fn(),
        remove: vi.fn(),
      },
    } as unknown as Cache

    // Mock Database with enough functionality for the workflow
    mockDb = {
      transaction: vi.fn().mockImplementation(async (cb) => {
        return await cb(mockDb)
      }),
      query: {
        customers: {
          findFirst: vi.fn().mockResolvedValue({
            id: customerId,
            active: true,
            projectId,
            subscriptions: [],
            project: { timezone: "UTC" },
          }),
        },
        subscriptions: {
          findFirst: vi.fn().mockImplementation(() => {
            return Promise.resolve({
              id: "sub_123",
              projectId,
              customerId,
              active: true,
              status: "active",
              phases: [],
              customer: { id: customerId }, // Crucial for machine loading
            })
          }),
        },
        subscriptionPhases: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "phase_123",
              projectId,
              subscriptionId: "sub_123",
              planVersionId: "pv_123",
              startAt: initialNow,
              endAt: null,
              billingAnchor: 1,
              planVersion: mockPlanVersion,
              items: mockPlanVersion.planFeatures.map((f) => ({
                id: "item_123",
                featurePlanVersionId: f.id,
                featurePlanVersion: f,
                units: 1,
              })),
              subscription: { customerId },
            },
          ]),
        },
        billingPeriods: {
          findFirst: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
        },
        creditGrants: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        invoiceItems: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        versions: { findFirst: vi.fn() },
        entitlements: {
          findFirst: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
        },
        grants: {
          findFirst: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockImplementation(() => {
            // Return active grants based on feature slug and clock.now()
            return Promise.resolve([
              {
                id: "grant_1",
                projectId,
                subjectType: "customer",
                subjectId: customerId,
                type: "subscription",
                featurePlanVersionId: "fpv_123",
                effectiveAt: initialNow,
                expiresAt: initialNow + 365 * 24 * 60 * 60 * 1000, // 1 year
                priority: 10,
                limit: 1000,
                anchor: 1,
                featurePlanVersion: {
                  feature: { slug: featureSlug },
                  featureType: "usage",
                  aggregationMethod: "sum",
                  config: { usageMode: "sum" },
                  billingConfig: {
                    name: "standard",
                    billingInterval: "month",
                    billingIntervalCount: 1,
                    planType: "recurring",
                  },
                  resetConfig: {
                    name: "standard",
                    resetInterval: "month",
                    resetIntervalCount: 1,
                    planType: "recurring",
                    resetAnchor: 1,
                  },
                  metadata: { overageStrategy: "none" },
                },
              },
            ])
          }),
        },
      },
      insert: vi.fn(() => ({
        values: vi.fn().mockImplementation((values) => ({
          returning: vi.fn().mockResolvedValue([Array.isArray(values) ? values[0] : values]),
          onConflictDoNothing: vi.fn().mockImplementation(() => ({
            returning: vi.fn().mockResolvedValue([Array.isArray(values) ? values[0] : values]),
          })),
          onConflictDoUpdate: vi.fn().mockImplementation((params) => ({
            returning: vi.fn().mockResolvedValue([{ ...values, ...params.set }]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn().mockImplementation((set) => ({
          where: vi.fn().mockImplementation(() => ({
            returning: vi.fn().mockResolvedValue([set]),
          })),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    } as unknown as Database

    mockStorage = new MemoryEntitlementStorageProvider({
      logger: mockLogger,
      analytics: mockAnalytics,
    })
    await mockStorage.initialize()

    const serviceDeps = {
      db: mockDb,
      logger: mockLogger,
      analytics: mockAnalytics,
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      waitUntil: (p: Promise<any>) => p,
      cache: mockCache,
      metrics: mockMetrics,
    }

    customerService = new CustomerService(serviceDeps)
    customerService.validatePaymentMethod = vi
      .fn()
      .mockResolvedValue(Ok({ paymentMethodId: null, requiredPaymentMethod: false }))

    _billingService = new BillingService(serviceDeps)
    entitlementService = new EntitlementService({ ...serviceDeps, storage: mockStorage })
    subscriptionService = new SubscriptionService(serviceDeps)
  })

  it("should handle a full month lifecycle: signup -> usage -> cycle reset", async () => {
    // 1. Sign up & Subscription
    vi.spyOn(mockDb.query.versions, "findFirst").mockResolvedValue(
      mockPlanVersion as unknown as PlanVersion
    )

    // Create Subscription
    const subResult = await subscriptionService.createSubscription({
      input: { customerId, timezone: "UTC" },
      projectId,
    })
    expect(subResult.err).toBeUndefined()

    // 2. Report initial usage (Day 5)
    clock.advanceBy(5 * 24 * 60 * 60 * 1000)

    const mockEntitlement = createMockEntitlementState(
      {
        customerId,
        projectId,
        featureSlug,
        limit: 1000,
        effectiveAt: initialNow,
        expiresAt: initialNow + 365 * 24 * 60 * 60 * 1000,
        resetConfig: {
          name: "standard",
          resetInterval: "month",
          resetIntervalCount: 1,
          planType: "recurring",
          resetAnchor: 1,
        },
        meter: {
          usage: "0",
          lastReconciledId: "rec_initial",
          snapshotUsage: "0",
          lastCycleStart: initialNow,
          lastUpdated: initialNow,
        },
        grants: [
          {
            id: "grant_1",
            type: "subscription",
            priority: 10,
            limit: 1000,
            effectiveAt: initialNow,
            expiresAt: initialNow + 365 * 24 * 60 * 60 * 1000,
          },
        ],
      },
      initialNow
    )

    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue(mockEntitlement)

    const report1 = await entitlementService.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 100,
      timestamp: clock.now(),
      requestId: "req_1",
      idempotenceKey: "idem_1",
      metadata: null,
    })
    expect(report1.allowed).toBe(true)
    expect(report1.usage).toBe(100)

    // 3. Move to next month (Day 32) and verify reset
    // We expect the UsageMeter to detect the cycle change during reportUsage
    clock.advanceBy(27 * 24 * 60 * 60 * 1000) // Total 32 days

    const report2 = await entitlementService.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 50,
      timestamp: clock.now(),
      requestId: "req_2",
      idempotenceKey: "idem_2",
      metadata: null,
    })

    expect(report2.allowed).toBe(true)
    expect(report2.usage).toBe(50) // Should have reset to 0 before adding 50

    const stored = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(stored.val?.meter.usage).toBe("50")
  })

  it("should handle phase changes: upgrade -> downgrade with entitlement resets", async () => {
    // 1. Sign up & Subscription
    vi.spyOn(mockDb.query.versions, "findFirst").mockResolvedValue(
      mockPlanVersion as unknown as PlanVersion
    )

    // Create Subscription
    const subResult = await subscriptionService.createSubscription({
      input: { customerId, timezone: "UTC" },
      projectId,
    })
    expect(subResult.err).toBeUndefined()
    const subscriptionId = subResult.val!.id

    // 2. Report initial usage (Day 5)
    clock.advanceBy(5 * 24 * 60 * 60 * 1000)

    const mockEntitlement = createMockEntitlementState(
      {
        customerId,
        projectId,
        featureSlug,
        limit: 1000,
        effectiveAt: initialNow,
        expiresAt: initialNow + 365 * 24 * 60 * 60 * 1000,
        resetConfig: {
          name: "standard",
          resetInterval: "month",
          resetIntervalCount: 1,
          planType: "recurring",
          resetAnchor: 1,
        },
        meter: {
          usage: "0",
          lastReconciledId: "rec_initial",
          snapshotUsage: "0",
          lastCycleStart: initialNow,
          lastUpdated: initialNow,
        },
        grants: [
          {
            id: "grant_1",
            type: "subscription",
            priority: 10,
            limit: 1000,
            effectiveAt: initialNow,
            expiresAt: initialNow + 365 * 24 * 60 * 60 * 1000,
          },
        ],
      },
      initialNow
    )

    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue(mockEntitlement)

    // Report usage to establish a non-zero state before upgrade
    await entitlementService.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 100,
      timestamp: clock.now(),
      requestId: "req_pre_upgrade",
      idempotenceKey: "idem_pre_upgrade",
      metadata: null,
    })

    const storedBefore = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(storedBefore.val?.meter.usage).toBe("100")

    // 3. Upgrade Plan (Day 10)
    clock.advanceBy(5 * 24 * 60 * 60 * 1000) // Day 10

    // Simulate plan upgrade logic
    const upgradeResult = await subscriptionService.createPhase({
      input: {
        subscriptionId,
        planVersionId: "pv_premium",
        startAt: clock.now(),
        config: [
          {
            featurePlanId: "pf_premium_1",
            units: 5000,
            featureSlug: featureSlug,
          },
        ],
        customerId,
        paymentMethodRequired: false,
      },
      projectId,
      now: clock.now(),
    })

    expect(upgradeResult.err).toBeUndefined()

    // Verify entitlement reset call
    expect(unprice.customers.resetEntitlements).toHaveBeenCalledTimes(1)

    // Manually simulate the side effect of resetEntitlements (clearing storage)
    // because our mock of resetEntitlements doesn't do it.
    await mockStorage.delete({ customerId, projectId, featureSlug })

    // Simulate re-fetching entitlement after upgrade (which would happen on next usage report)
    // We update the mock DB to return the NEW grant structure (Premium)
    const premiumGrant = {
      id: "grant_premium",
      type: "subscription" as const,
      priority: 20, // Higher priority
      limit: 5000,
      effectiveAt: clock.now(),
      expiresAt: initialNow + 365 * 24 * 60 * 60 * 1000,
    }

    const premiumEntitlement = createMockEntitlementState(
      {
        ...mockEntitlement,
        limit: 5000,
        grants: [premiumGrant],
        meter: { ...mockEntitlement.meter, usage: "0" }, // New grant start usually implies fresh meter if configured
      },
      clock.now()
    )

    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue(premiumEntitlement)

    // Verify usage report against NEW entitlement
    const reportUpgrade = await entitlementService.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 50, // New usage
      timestamp: clock.now(),
      requestId: "req_post_upgrade",
      idempotenceKey: "idem_post_upgrade",
      metadata: null,
    })

    expect(reportUpgrade.allowed).toBe(true)
    expect(reportUpgrade.limit).toBe(5000) // Verified new limit

    // 4. Downgrade Plan (Day 20)
    clock.advanceBy(10 * 24 * 60 * 60 * 1000) // Day 20

    const downgradeResult = await subscriptionService.createPhase({
      input: {
        subscriptionId,
        planVersionId: "pv_123", // Back to base
        startAt: clock.now(),
        config: [],
        customerId,
        paymentMethodRequired: false,
      },
      projectId,
      now: clock.now(),
    })

    expect(downgradeResult.err).toBeUndefined()
    expect(unprice.customers.resetEntitlements).toHaveBeenCalledTimes(2) // Second call

    // Manually simulate the side effect of resetEntitlements (clearing storage)
    await mockStorage.delete({ customerId, projectId, featureSlug })

    // Simulate fetching entitlement after downgrade
    // Back to standard grant
    const standardGrant = {
      id: "grant_standard_back",
      type: "subscription" as const,
      priority: 10,
      limit: 1000,
      effectiveAt: clock.now(),
      expiresAt: initialNow + 365 * 24 * 60 * 60 * 1000,
    }

    const downgradedEntitlement = createMockEntitlementState(
      {
        ...mockEntitlement,
        limit: 1000,
        grants: [standardGrant],
        meter: { ...mockEntitlement.meter, usage: "0" }, // Reset usage for new phase
      },
      clock.now()
    )

    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue(downgradedEntitlement)

    // 5. Verify usage reset after downgrade
    // Reporting 10 units. Should start from 0 + 10 = 10.
    const reportDowngrade = await entitlementService.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 10,
      timestamp: clock.now(),
      requestId: "req_post_downgrade",
      idempotenceKey: "idem_post_downgrade",
      metadata: null,
    })

    expect(reportDowngrade.allowed).toBe(true)
    expect(reportDowngrade.usage).toBe(10) // Confirms usage reset
    expect(reportDowngrade.limit).toBe(1000) // Confirms limit reset to base
  })

  it("should handle proration for prepaid plan downgrade", async () => {
    // 1. Setup: Prepaid Plan
    const prepaidPlanVersion: PlanVersion = {
      ...mockPlanVersion,
      id: "pv_prepaid",
      plan: { id: "p_prepaid", slug: "prepaid" },
      // Important: Bill in advance
      whenToBill: "pay_in_advance",
      billingConfig: {
        ...mockPlanVersion.billingConfig,
        billingInterval: "month",
        billingIntervalCount: 1,
        planType: "recurring",
      },
      planFeatures: [], // Flat fee, no usage features for simplicity
    } as unknown as PlanVersion

    vi.spyOn(mockDb.query.versions, "findFirst").mockResolvedValue(prepaidPlanVersion)

    // Create Subscription
    const subResult = await subscriptionService.createSubscription({
      input: { customerId, timezone: "UTC" },
      projectId,
    })
    expect(subResult.err).toBeUndefined()
    const subscriptionId = subResult.val!.id

    // Simulate initial invoice generation (Day 0)
    // We assume the system would generate an invoice for the full month
    // We mock the database state as if that happened

    const cycleStart = initialNow
    const cycleEnd = initialNow + 30 * 24 * 60 * 60 * 1000 // 30 days

    // Mock existing paid invoice items for proration logic
    const paidInvoiceItem = {
      id: "ii_1",
      invoiceId: "inv_1",
      billingPeriodId: "bp_1",
      amountTotal: 10000, // $100.00
      prorationFactor: 1,
      subscriptionItem: {
        featurePlanVersion: {
          featureType: "flat", // Proration only for flat/tier/package
          billingConfig: prepaidPlanVersion.billingConfig,
        },
        // Required for deep property access in billing service
        subscriptionPhase: {
          planVersion: prepaidPlanVersion,
        },
      },
      invoice: {
        status: "paid",
      },
    }

    const invoicedPeriod = {
      id: "bp_1",
      subscriptionPhaseId: "phase_1", // The current phase
      status: "invoiced",
      cycleStartAt: cycleStart,
      cycleEndAt: cycleEnd,
      whenToBill: "pay_in_advance", // Required by internal logic
      invoiceAt: cycleStart, // Required field
    }

    // 2. Time Travel: Mid-month (Day 15)
    clock.advanceBy(15 * 24 * 60 * 60 * 1000)
    const downgradeTime = clock.now()

    // Mock DB queries for proration check
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    vi.spyOn(mockDb.query.billingPeriods, "findMany").mockResolvedValue([invoicedPeriod] as any)
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    vi.spyOn(mockDb.query.invoiceItems, "findFirst").mockResolvedValue(paidInvoiceItem as any)
    vi.spyOn(mockDb.query.creditGrants, "findFirst").mockResolvedValue(undefined) // No credit yet

    const insertSpy = vi.spyOn(mockDb, "insert")
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const allInsertValues: any[] = []

    // We intercept the `values` call on the insert builder to verify arguments
    insertSpy.mockImplementation(
      () =>
        ({
          values: vi.fn().mockImplementation((values) => {
            allInsertValues.push(values) // Capture all inserted values
            return {
              returning: vi.fn().mockResolvedValue([Array.isArray(values) ? values[0] : values]),
              onConflictDoNothing: vi.fn().mockImplementation(() => ({
                returning: vi.fn().mockResolvedValue([Array.isArray(values) ? values[0] : values]),
              })),
              onConflictDoUpdate: vi.fn().mockImplementation((params) => ({
                returning: vi.fn().mockResolvedValue([{ ...values, ...params.set }]),
              })),
            }
          }),
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        }) as any
    )

    // 3. Downgrade / Cancel (Shorten the phase)
    // We simulate a phase change where the current phase ends NOW
    // In `BillingService._generateBillingPeriods`, it detects `phase.endAt` < `billingPeriod.cycleEndAt`

    // We need to mock `subscriptionPhases.findMany` to return the phase that is ENDING
    // mock the query with parameters (including with for eager loading)
    vi.spyOn(mockDb.query.subscriptionPhases, "findMany").mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: Mock implementation needs to accept Drizzle query options
      (_options?: any): any => {
        return Promise.resolve([
          {
            id: "phase_1",
            projectId,
            subscriptionId,
            planVersionId: prepaidPlanVersion.id,
            startAt: cycleStart,
            endAt: downgradeTime, // The phase effectively ends now due to change
            billingAnchor: 1,
            items: [
              {
                id: "si_1",
                featurePlanVersion: {
                  featureType: "flat",
                  billingConfig: prepaidPlanVersion.billingConfig,
                },
              },
            ],
            subscription: { customerId },
            metadata: {
              reason: "payment_failed",
              note: "Payment failed",
            },
            planVersion: prepaidPlanVersion, // Also needed here for some access patterns
          },
        ])
      }
    )

    // 4. Run Billing Generation
    const billingResult = await _billingService.generateBillingPeriods({
      subscriptionId,
      projectId,
      now: downgradeTime,
      dryRun: false, // We want to test the side effects (credit creation) logic flow
    })

    expect(billingResult.err).toBeUndefined()

    // 5. Verify Credit Grant Creation
    expect(insertSpy).toHaveBeenCalled()

    // Find the credit grant insert among all inserts
    const creditGrantInsert =
      allInsertValues.find((val) => !Array.isArray(val) && val.reason === "mid_cycle_change") ||
      allInsertValues.flat().find((val) => val.reason === "mid_cycle_change")

    expect(creditGrantInsert).toBeDefined()
    expect(creditGrantInsert).toMatchObject({
      reason: "mid_cycle_change",
      projectId,
      customerId,
      // Total was 10000 cents. Used 50%. Refund roughly 5000 cents.
      totalAmount: expect.any(Number),
    })

    // Verify amount is positive and roughly half
    const refundAmount = creditGrantInsert.totalAmount
    expect(refundAmount).toBeGreaterThan(0)
    expect(refundAmount).toBeLessThan(10000)
    // Month has 31 days. 15 days used. ~16 days remaining.
    // 10000 * (16/31) ~= 5161.
    expect(refundAmount).toBeCloseTo(5161, -2) // Allow small rounding diffs
  })
})
