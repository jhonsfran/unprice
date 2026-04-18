import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { PlanVersion } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BillingService } from "../billing/service"
import type { Cache } from "../cache/service"
import { CustomerService } from "../customers/service"
import { GrantsManager } from "../entitlements/grants"
import { LedgerGateway } from "../ledger"
import type { Metrics } from "../metrics"
import { PaymentProviderResolver } from "../payment-provider/resolver"
import { RatingService } from "../rating/service"
import { DrizzleSubscriptionRepository } from "../subscriptions/repository.drizzle"
import { SubscriptionService } from "../subscriptions/service"
import { createClock } from "../test-utils"

vi.mock("../env", () => ({
  env: {
    ENCRYPTION_KEY: "test_encryption_key",
    NODE_ENV: "test",
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

describe("Workflow - Billing and Subscriptions", () => {
  let subscriptionService: SubscriptionService
  let _billingService: BillingService

  let mockDb: Database
  let mockAnalytics: Analytics
  let mockCache: Cache
  let mockLogger: Logger
  let mockMetrics: Metrics

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
        unitOfMeasure: "units",
        meterConfig: {
          eventId: "event_api_requests",
          eventSlug: featureSlug,
          aggregationMethod: "sum",
          aggregationField: "value",
        },
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
      set: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    } as unknown as Logger

    mockAnalytics = {
      ingestFeaturesVerification: vi.fn().mockResolvedValue({ successful_rows: 1 }),
      ingestFeaturesUsage: vi.fn().mockResolvedValue({ successful_rows: 1 }),
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
      customerRelevantEntitlements: {
        remove: vi.fn(),
        swr: vi
          .fn()
          .mockImplementation(async (_key, fetcher) => ({ val: await fetcher(), fresh: true })),
        set: vi.fn(),
        get: vi.fn(),
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
                  unitOfMeasure: "units",
                  meterConfig: {
                    eventId: "event_api_requests",
                    eventSlug: featureSlug,
                    aggregationMethod: "sum",
                    aggregationField: "value",
                  },
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

    const serviceDeps = {
      db: mockDb,
      logger: mockLogger,
      analytics: mockAnalytics,
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      waitUntil: (p: Promise<any>) => p,
      cache: mockCache,
      metrics: mockMetrics,
    }

    const paymentProviderResolver = new PaymentProviderResolver({
      db: mockDb,
      logger: mockLogger,
    })
    const customerService = new CustomerService({ ...serviceDeps, paymentProviderResolver })
    const grantsManager = new GrantsManager({ db: mockDb, logger: mockLogger })
    const ratingService = new RatingService({ ...serviceDeps, grantsManager })
    const ledgerService = new LedgerGateway({
      db: mockDb,
      logger: mockLogger,
    })
    _billingService = new BillingService({
      ...serviceDeps,
      customerService,
      grantsManager,
      ratingService,
      ledgerService,
    })
    subscriptionService = new SubscriptionService({
      ...serviceDeps,
      repo: new DrizzleSubscriptionRepository(mockDb),
      customerService,
      billingService: _billingService,
      ratingService,
      ledgerService,
    })
  })

  const captureInsertValues = () => {
    const allInsertValues: unknown[] = []

    const insertSpy = vi.spyOn(mockDb, "insert").mockImplementation(
      () =>
        ({
          values: vi.fn().mockImplementation((values) => {
            allInsertValues.push(values)
            return {
              returning: vi.fn().mockResolvedValue(Array.isArray(values) ? values : [values]),
              onConflictDoNothing: vi.fn().mockImplementation(() => ({
                returning: vi.fn().mockResolvedValue(Array.isArray(values) ? values : [values]),
              })),
              onConflictDoUpdate: vi.fn().mockImplementation((params) => ({
                returning: vi.fn().mockResolvedValue([{ ...values, ...params.set }]),
              })),
            }
          }),
          // biome-ignore lint/suspicious/noExplicitAny: test double shape
        }) as any
    )

    return {
      allInsertValues,
      insertSpy,
    }
  }

  const findMidCycleCreditInsert = (allInsertValues: unknown[]) => {
    return (
      allInsertValues.find(
        (value): value is Record<string, unknown> =>
          !Array.isArray(value) &&
          typeof value === "object" &&
          value !== null &&
          (value as { reason?: unknown }).reason === "mid_cycle_change"
      ) ||
      allInsertValues
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .find(
          (value): value is Record<string, unknown> =>
            typeof value === "object" &&
            value !== null &&
            (value as { reason?: unknown }).reason === "mid_cycle_change"
        )
    )
  }

  const runProrationScenario = async ({
    invoiceStatus = "paid",
    featureType = "flat",
    existingCredit,
    dryRun = false,
  }: {
    invoiceStatus?: string
    featureType?: "flat" | "usage"
    existingCredit?: unknown
    dryRun?: boolean
  } = {}) => {
    const prepaidPlanVersion: PlanVersion = {
      ...mockPlanVersion,
      id: "pv_prepaid",
      plan: { id: "p_prepaid", slug: "prepaid" },
      whenToBill: "pay_in_advance",
      paymentProvider: "sandbox",
      collectionMethod: "charge_automatically",
      currency: "usd",
      billingConfig: {
        ...mockPlanVersion.billingConfig,
        billingInterval: "month",
        billingIntervalCount: 1,
        planType: "recurring",
      },
      planFeatures: [],
    } as unknown as PlanVersion

    vi.spyOn(mockDb.query.versions, "findFirst").mockResolvedValue(prepaidPlanVersion)

    const subResult = await subscriptionService.createSubscription({
      input: { customerId, timezone: "UTC" },
      projectId,
    })
    expect(subResult.err).toBeUndefined()
    const subscriptionId = subResult.val!.id

    const cycleStart = initialNow
    const cycleEnd = initialNow + 30 * 24 * 60 * 60 * 1000

    const invoiceItem = {
      id: "ii_1",
      invoiceId: "inv_1",
      billingPeriodId: "bp_1",
      amountTotal: 10000,
      prorationFactor: 1,
      subscriptionItem: {
        featurePlanVersion: {
          featureType,
          unitOfMeasure: "units",
          billingConfig: prepaidPlanVersion.billingConfig,
        },
        subscriptionPhase: {
          planVersion: prepaidPlanVersion,
        },
      },
      invoice: {
        status: invoiceStatus,
      },
    }

    const invoicedPeriod = {
      id: "bp_1",
      subscriptionPhaseId: "phase_1",
      status: "invoiced",
      cycleStartAt: cycleStart,
      cycleEndAt: cycleEnd,
      whenToBill: "pay_in_advance",
      invoiceAt: cycleStart,
    }

    clock.advanceBy(15 * 24 * 60 * 60 * 1000)
    const downgradeTime = clock.now()

    // biome-ignore lint/suspicious/noExplicitAny: test setup
    vi.spyOn(mockDb.query.billingPeriods, "findMany").mockResolvedValue([invoicedPeriod] as any)
    // biome-ignore lint/suspicious/noExplicitAny: test setup
    vi.spyOn(mockDb.query.invoiceItems, "findFirst").mockResolvedValue(invoiceItem as any)
    // biome-ignore lint/suspicious/noExplicitAny: test setup
    vi.spyOn(mockDb.query.creditGrants, "findFirst").mockResolvedValue(existingCredit as any)

    const { allInsertValues, insertSpy } = captureInsertValues()
    const updateSetCalls: Array<Record<string, unknown>> = []
    const updateSpy = vi.spyOn(mockDb, "update").mockImplementation(
      () =>
        ({
          set: vi.fn().mockImplementation((set) => {
            if (set && typeof set === "object") {
              updateSetCalls.push(set as Record<string, unknown>)
            }
            return {
              where: vi.fn().mockResolvedValue([]),
            }
          }),
          // biome-ignore lint/suspicious/noExplicitAny: test double shape
        }) as any
    )

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
            endAt: downgradeTime,
            billingAnchor: 1,
            items: [
              {
                id: "si_1",
                featurePlanVersion: {
                  featureType,
                  unitOfMeasure: "units",
                  billingConfig: prepaidPlanVersion.billingConfig,
                },
              },
            ],
            subscription: { customerId },
            metadata: {
              reason: "payment_failed",
              note: "Payment failed",
            },
            planVersion: prepaidPlanVersion,
          },
        ])
      }
    )

    const billingResult = await _billingService.generateBillingPeriods({
      subscriptionId,
      projectId,
      now: downgradeTime,
      dryRun,
    })

    return {
      billingResult,
      allInsertValues,
      updateSetCalls,
      downgradeTime,
      insertSpy,
      updateSpy,
    }
  }

  it("materializes billing periods without resolving or storing grantId", async () => {
    const allInsertValues: unknown[] = []
    const grantsFindFirstSpy = vi.spyOn(mockDb.query.grants, "findFirst")

    vi.spyOn(mockDb, "insert").mockImplementation(
      () =>
        ({
          values: vi.fn().mockImplementation((values) => {
            allInsertValues.push(values)
            return {
              returning: vi.fn().mockResolvedValue(Array.isArray(values) ? values : [values]),
              onConflictDoNothing: vi.fn().mockImplementation(() => ({
                returning: vi.fn().mockResolvedValue(Array.isArray(values) ? values : [values]),
              })),
              onConflictDoUpdate: vi.fn().mockImplementation((params) => ({
                returning: vi.fn().mockResolvedValue([{ ...values, ...params.set }]),
              })),
            }
          }),
          // biome-ignore lint/suspicious/noExplicitAny: test double shape
        }) as any
    )

    const billingResult = await _billingService.generateBillingPeriods({
      subscriptionId: "sub_123",
      projectId,
      now: clock.now(),
      dryRun: false,
    })

    expect(billingResult.err).toBeUndefined()
    expect(grantsFindFirstSpy).not.toHaveBeenCalled()

    const billingPeriodInsert = allInsertValues
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .find(
        (value): value is Record<string, unknown> =>
          typeof value === "object" &&
          value !== null &&
          String((value as { id?: unknown }).id ?? "").startsWith("billing_period_")
      )

    expect(billingPeriodInsert).toBeDefined()
    expect(billingPeriodInsert).not.toHaveProperty("grantId")
    expect(billingPeriodInsert).toMatchObject({
      projectId,
      subscriptionId: "sub_123",
      customerId,
      subscriptionPhaseId: "phase_123",
      subscriptionItemId: "item_123",
    })
  })

  it("creates phase-owned grants with subscription metadata for active phases", async () => {
    vi.spyOn(mockDb.query.versions, "findFirst").mockResolvedValue(
      mockPlanVersion as unknown as PlanVersion
    )

    const allInsertValues: unknown[] = []

    vi.spyOn(mockDb, "insert").mockImplementation(
      () =>
        ({
          values: vi.fn().mockImplementation((values) => {
            allInsertValues.push(values)
            return {
              returning: vi.fn().mockResolvedValue(Array.isArray(values) ? values : [values]),
              onConflictDoNothing: vi.fn().mockImplementation(() => ({
                returning: vi.fn().mockResolvedValue(Array.isArray(values) ? values : [values]),
              })),
              onConflictDoUpdate: vi.fn().mockImplementation((params) => ({
                returning: vi.fn().mockResolvedValue([{ ...values, ...params.set }]),
              })),
            }
          }),
          // biome-ignore lint/suspicious/noExplicitAny: test double shape
        }) as any
    )

    const createPhaseResult = await subscriptionService.createPhase({
      input: {
        subscriptionId: "sub_123",
        planVersionId: "pv_123",
        startAt: clock.now(),
        config: [
          {
            featurePlanId: "pf_1",
            units: 1000,
            featureSlug,
          },
        ],
        customerId,
        paymentMethodRequired: false,
      },
      projectId,
      now: clock.now(),
    })

    expect(createPhaseResult.err).toBeUndefined()

    const grantInsert = allInsertValues
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .find(
        (value): value is Record<string, unknown> =>
          typeof value === "object" &&
          value !== null &&
          (value as { subjectType?: unknown }).subjectType === "customer" &&
          (value as { featurePlanVersionId?: unknown }).featurePlanVersionId === "pf_1"
      )

    expect(grantInsert).toBeDefined()
    expect(grantInsert).toMatchObject({
      projectId,
      subjectType: "customer",
      subjectId: customerId,
      featurePlanVersionId: "pf_1",
      type: "subscription",
      autoRenew: false,
      metadata: {
        subscriptionId: "sub_123",
        subscriptionPhaseId: expect.any(String),
        subscriptionItemId: expect.any(String),
      },
    })
  })

  it("creates proration credit for prepaid downgrade when eligible", async () => {
    const { billingResult, allInsertValues } = await runProrationScenario()
    expect(billingResult.err).toBeUndefined()

    const creditGrantInsert = findMidCycleCreditInsert(allInsertValues)
    expect(creditGrantInsert).toBeDefined()
    expect(creditGrantInsert).toMatchObject({
      reason: "mid_cycle_change",
      projectId,
      customerId,
      totalAmount: expect.any(Number),
    })

    const refundAmount = creditGrantInsert!.totalAmount as number
    expect(refundAmount).toBeGreaterThan(0)
    expect(refundAmount).toBeLessThan(10000)
    expect(refundAmount).toBeCloseTo(5161, -2)
  })

  it("does not create duplicate mid-cycle credit when one already exists", async () => {
    const { billingResult, allInsertValues } = await runProrationScenario({
      existingCredit: { id: "credit_existing" },
    })

    expect(billingResult.err).toBeUndefined()
    expect(findMidCycleCreditInsert(allInsertValues)).toBeUndefined()
  })

  it.each([
    {
      name: "invoice is not paid",
      invoiceStatus: "open",
      featureType: "flat" as const,
    },
    {
      name: "feature type is usage",
      invoiceStatus: "paid",
      featureType: "usage" as const,
    },
  ])("does not create mid-cycle credit when $name", async ({ invoiceStatus, featureType }) => {
    const { billingResult, allInsertValues } = await runProrationScenario({
      invoiceStatus,
      featureType,
    })

    expect(billingResult.err).toBeUndefined()
    expect(findMidCycleCreditInsert(allInsertValues)).toBeUndefined()
  })

  it("caps shortened invoiced periods to the phase end date", async () => {
    const { billingResult, updateSetCalls, downgradeTime } = await runProrationScenario()
    expect(billingResult.err).toBeUndefined()
    expect(updateSetCalls).toContainEqual(expect.objectContaining({ cycleEndAt: downgradeTime }))
  })

  it.each([
    { whenToBill: "pay_in_advance", expectedField: "cycleStartAt" as const },
    { whenToBill: "pay_in_arrear", expectedField: "cycleEndAt" as const },
  ])(
    "maps invoiceAt correctly when whenToBill=$whenToBill",
    async ({ whenToBill, expectedField }) => {
      const planVersion = {
        ...mockPlanVersion,
        id: `pv_${whenToBill}`,
        whenToBill,
        paymentProvider: "sandbox",
        collectionMethod: "charge_automatically",
        currency: "usd",
      } as unknown as PlanVersion

      vi.spyOn(mockDb.query.versions, "findFirst").mockResolvedValue(planVersion)

      const subResult = await subscriptionService.createSubscription({
        input: { customerId, timezone: "UTC" },
        projectId,
      })
      expect(subResult.err).toBeUndefined()
      const subscriptionId = subResult.val!.id

      vi.spyOn(mockDb.query.subscriptionPhases, "findMany").mockResolvedValue([
        {
          id: "phase_when_to_bill",
          projectId,
          subscriptionId,
          planVersionId: planVersion.id,
          startAt: initialNow,
          endAt: null,
          billingAnchor: 1,
          items: [
            {
              id: "item_when_to_bill",
              featurePlanVersion: {
                featureType: "flat",
                unitOfMeasure: "units",
                billingConfig: {
                  name: "standard",
                  billingInterval: "month",
                  billingIntervalCount: 1,
                  planType: "recurring",
                },
              },
            },
          ],
          subscription: { customerId },
          planVersion,
        },
        // biome-ignore lint/suspicious/noExplicitAny: test setup
      ] as any)

      const { allInsertValues } = captureInsertValues()
      const now = initialNow + 2 * 24 * 60 * 60 * 1000
      const billingResult = await _billingService.generateBillingPeriods({
        subscriptionId,
        projectId,
        now,
        dryRun: false,
      })

      expect(billingResult.err).toBeUndefined()

      const billingPeriodInsert = allInsertValues
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .find(
          (value): value is Record<string, unknown> =>
            typeof value === "object" &&
            value !== null &&
            String((value as { id?: unknown }).id ?? "").startsWith("billing_period_")
        )

      expect(billingPeriodInsert).toBeDefined()
      expect(billingPeriodInsert?.whenToBill).toBe(whenToBill)
      expect(billingPeriodInsert?.invoiceAt).toBe(billingPeriodInsert?.[expectedField])
      expect(typeof billingPeriodInsert?.statementKey).toBe("string")
    }
  )

  it("does not write billing periods or credits in dryRun mode", async () => {
    const { billingResult, insertSpy, updateSpy } = await runProrationScenario({
      dryRun: true,
    })

    expect(billingResult.err).toBeUndefined()
    expect(insertSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })
})
