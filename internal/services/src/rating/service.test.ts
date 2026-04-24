import type { Analytics } from "@unprice/analytics"
import type { Entitlement, grantSchemaExtended } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { formatAmountForProvider } from "@unprice/money"
import { dinero } from "dinero.js"
import * as dineroCurrencies from "dinero.js/currencies"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { z } from "zod"
import type { GrantsManager } from "../entitlements"
import { UnPriceRatingError } from "./errors"
import { RatingService } from "./service"

describe("RatingService", () => {
  const projectId = "proj_rating"
  const customerId = "cust_rating"
  const featureSlug = "api_requests"
  const now = Date.now()
  const USD = dineroCurrencies.USD

  type TestGrant = z.infer<typeof grantSchemaExtended>

  let activeGrants: TestGrant[]
  let mockAnalytics: Analytics
  let mockLogger: Logger
  let mockGetGrantsForCustomer: ReturnType<typeof vi.fn>
  let mockComputeEntitlementState: ReturnType<typeof vi.fn>
  let ratingService: RatingService

  const makePrice = (amount: number, displayAmount: string) => ({
    dinero: dinero({ amount, currency: USD }).toJSON(),
    displayAmount,
  })

  const makeGrant = ({
    id,
    config,
    featureType,
    limit = 1_000,
    slug = featureSlug,
    priority = 10,
    type = "subscription",
    effectiveAt = now - 60_000,
    expiresAt = now + 60_000,
  }: {
    id: string
    config: Record<string, unknown>
    featureType: "usage" | "flat" | "tier" | "package"
    limit?: number
    slug?: string
    priority?: number
    type?: "subscription" | "trial"
    effectiveAt?: number
    expiresAt?: number
  }): TestGrant =>
    ({
      id,
      createdAtM: now - 10_000,
      updatedAtM: now - 1_000,
      projectId,
      name: `grant_${id}`,
      subjectType: "customer",
      subjectId: customerId,
      type,
      featurePlanVersionId: `fpv_${id}`,
      effectiveAt,
      expiresAt,
      limit,
      units: 1,
      overageStrategy: "none",
      metadata: null,
      deleted: false,
      deletedAt: null,
      autoRenew: true,
      priority,
      anchor: 1,
      featurePlanVersion: {
        id: `fpv_${id}`,
        createdAtM: now - 10_000,
        updatedAtM: now - 1_000,
        projectId,
        planVersionId: "pv_test",
        type: "feature",
        featureId: `feat_${id}`,
        order: 1,
        defaultQuantity: 1,
        limit,
        feature: {
          id: `feat_${id}`,
          createdAtM: now - 10_000,
          updatedAtM: now - 1_000,
          projectId,
          slug,
          code: 1,
          unitOfMeasure: "units",
          title: "API Requests",
          description: null,
          meterConfig: null,
        },
        featureType,
        unitOfMeasure: "units",
        meterConfig:
          featureType === "usage"
            ? {
                eventId: "evt_api_requests",
                eventSlug: slug,
                aggregationMethod: "sum",
                aggregationField: "value",
              }
            : null,
        config,
        billingConfig: {
          name: "standard",
          billingInterval: "month",
          billingIntervalCount: 1,
          billingAnchor: 1,
          planType: "recurring",
        },
        resetConfig: {
          name: "standard",
          resetInterval: "month",
          resetIntervalCount: 1,
          planType: "recurring",
          resetAnchor: 1,
        },
        metadata: {
          realtime: false,
          notifyUsageThreshold: 95,
          overageStrategy: "none",
          blockCustomer: false,
          hidden: false,
        },
      },
    }) as unknown as TestGrant

  beforeEach(() => {
    activeGrants = []

    mockAnalytics = {
      getUsageBillingFeatures: vi.fn().mockResolvedValue(Ok([])),
    } as unknown as Analytics

    mockLogger = {
      set: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger

    mockGetGrantsForCustomer = vi.fn().mockImplementation(async () =>
      Ok({
        grants: activeGrants,
        subscription: null,
        planVersion: null,
      })
    )

    mockComputeEntitlementState = vi
      .fn()
      .mockImplementation(async ({ grants }: { grants: TestGrant[] }) => {
        const first = grants[0]
        const entitlement = {
          featureSlug: first?.featurePlanVersion.feature.slug ?? featureSlug,
          featureType: first?.featurePlanVersion.featureType ?? "usage",
          meterConfig: first?.featurePlanVersion.meterConfig ?? null,
          effectiveAt: first?.effectiveAt ?? now - 60_000,
          expiresAt: first?.expiresAt ?? now + 60_000,
          resetConfig: null,
        } as unknown as Omit<Entitlement, "id">

        return Ok(entitlement)
      })

    const mockGrantsManager = {
      getGrantsForCustomer: mockGetGrantsForCustomer,
      computeEntitlementState: mockComputeEntitlementState,
    } as unknown as GrantsManager

    ratingService = new RatingService({
      logger: mockLogger,
      analytics: mockAnalytics,
      grantsManager: mockGrantsManager,
    })
  })

  it("uses pre-fetched grants and usage data without duplicate reads", async () => {
    const usageGrant = makeGrant({
      id: "usage_1",
      featureType: "usage",
      limit: 1_000,
      config: {
        usageMode: "unit",
        price: makePrice(100, "1.00"),
      },
    })

    const result = await ratingService.rateBillingPeriod({
      projectId,
      customerId,
      featureSlug,
      now,
      grants: [usageGrant],
      usageData: [{ featureSlug, usage: 7 }],
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toHaveLength(1)
    expect(mockGetGrantsForCustomer).not.toHaveBeenCalled()
    expect(mockAnalytics.getUsageBillingFeatures).not.toHaveBeenCalled()

    const totalAmount = result.val!.reduce(
      (total, item) => total + formatAmountForProvider(item.price.totalPrice.dinero).amount,
      0
    )
    expect(totalAmount).toBe(700)
  })

  it("returns empty list when no grants match the feature", async () => {
    activeGrants = [
      makeGrant({
        id: "other_feature",
        featureType: "usage",
        slug: "different_feature",
        config: {
          usageMode: "unit",
          price: makePrice(100, "1.00"),
        },
      }),
    ]

    const result = await ratingService.rateBillingPeriod({
      projectId,
      customerId,
      featureSlug,
      now,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual([])
    expect(mockGetGrantsForCustomer).toHaveBeenCalledTimes(1)
    expect(mockComputeEntitlementState).not.toHaveBeenCalled()
  })

  it("computes marginal delta for flat pricing", async () => {
    const flatGrant = makeGrant({
      id: "flat_1",
      featureType: "flat",
      config: {
        price: makePrice(500, "5.00"),
      },
    })

    const result = await ratingService.rateIncrementalUsage({
      projectId,
      customerId,
      featureSlug,
      now,
      usageBefore: 0,
      usageAfter: 1,
      grants: [flatGrant],
    })

    expect(result.err).toBeUndefined()
    expect(formatAmountForProvider(result.val!.deltaPrice.totalPrice.dinero).amount).toBe(500)
  })

  it("computes marginal delta for tier pricing", async () => {
    const tierGrant = makeGrant({
      id: "tier_1",
      featureType: "tier",
      config: {
        usageMode: "tier",
        tierMode: "graduated",
        tiers: [
          {
            firstUnit: 1,
            lastUnit: 10,
            unitPrice: makePrice(100, "1.00"),
            flatPrice: makePrice(0, "0.00"),
          },
          {
            firstUnit: 11,
            lastUnit: null,
            unitPrice: makePrice(50, "0.50"),
            flatPrice: makePrice(0, "0.00"),
          },
        ],
      },
    })

    const result = await ratingService.rateIncrementalUsage({
      projectId,
      customerId,
      featureSlug,
      now,
      usageBefore: 10,
      usageAfter: 12,
      grants: [tierGrant],
    })

    expect(result.err).toBeUndefined()
    expect(formatAmountForProvider(result.val!.deltaPrice.totalPrice.dinero).amount).toBe(100)
  })

  it("computes marginal delta for package pricing", async () => {
    const packageGrant = makeGrant({
      id: "package_1",
      featureType: "package",
      config: {
        usageMode: "package",
        units: 5,
        price: makePrice(1_000, "10.00"),
      },
    })

    const result = await ratingService.rateIncrementalUsage({
      projectId,
      customerId,
      featureSlug,
      now,
      usageBefore: 4,
      usageAfter: 6,
      grants: [packageGrant],
    })

    expect(result.err).toBeUndefined()
    expect(formatAmountForProvider(result.val!.deltaPrice.totalPrice.dinero).amount).toBe(1_000)
  })

  describe("multi-grant waterfall", () => {
    it("attributes usage across two grants by priority (higher priority consumed first)", async () => {
      // Waterfall sorts by higher priority first: b.priority - a.priority
      // Grant A: priority 20 (consumed first), limit 5
      const grantA = makeGrant({
        id: "wf_a",
        featureType: "usage",
        limit: 5,
        priority: 20,
        config: {
          usageMode: "unit",
          price: makePrice(100, "1.00"),
        },
      })

      // Grant B: priority 1 (overflow target), limit 1000
      const grantB = makeGrant({
        id: "wf_b",
        featureType: "usage",
        limit: 1_000,
        priority: 1,
        config: {
          usageMode: "unit",
          price: makePrice(200, "2.00"),
        },
      })

      const result = await ratingService.rateBillingPeriod({
        projectId,
        customerId,
        featureSlug,
        now,
        grants: [grantA, grantB],
        usageData: [{ featureSlug, usage: 8 }],
      })

      expect(result.err).toBeUndefined()
      // 2 grants should produce 2 rated charges
      expect(result.val!.length).toBe(2)

      const chargeA = result.val!.find((c) => c.grantId === "wf_a")!
      const chargeB = result.val!.find((c) => c.grantId === "wf_b")!

      // Grant A (higher priority) consumes first 5 units
      expect(chargeA.usage).toBe(5)
      expect(formatAmountForProvider(chargeA.price.totalPrice.dinero).amount).toBe(500)

      // Grant B gets remaining 3 units at $2/unit
      expect(chargeB.usage).toBe(3)
      expect(formatAmountForProvider(chargeB.price.totalPrice.dinero).amount).toBe(600)
    })

    it("handles overage when usage exceeds all grant limits", async () => {
      const limitedGrant = makeGrant({
        id: "limited",
        featureType: "usage",
        limit: 3,
        config: {
          usageMode: "unit",
          price: makePrice(100, "1.00"),
        },
      })

      const result = await ratingService.rateBillingPeriod({
        projectId,
        customerId,
        featureSlug,
        now,
        grants: [limitedGrant],
        usageData: [{ featureSlug, usage: 7 }],
      })

      expect(result.err).toBeUndefined()
      // Waterfall: 3 units within limit + 4 units overage (attributed to same grant)
      expect(result.val!.length).toBe(2)

      // Both charges are attributed to the same grant (waterfall overage behavior)
      const charges = result.val!.filter((c) => c.grantId === "limited")
      expect(charges.length).toBe(2)

      const baseCharge = charges.find((c) => c.usage === 3)!
      expect(formatAmountForProvider(baseCharge.price.totalPrice.dinero).amount).toBe(300)

      const overageCharge = charges.find((c) => c.usage === 4)!
      expect(overageCharge.usage).toBe(4)
      // Overage is marginal: price(7) - price(3) = 700 - 300 = 400
      expect(formatAmountForProvider(overageCharge.price.totalPrice.dinero).amount).toBe(400)
    })
  })

  describe("trial grants", () => {
    it("trial grants get proration factor 0 (no charge)", async () => {
      const trialGrant = makeGrant({
        id: "trial_1",
        featureType: "usage",
        limit: 100,
        type: "trial",
        config: {
          usageMode: "unit",
          price: makePrice(100, "1.00"),
        },
      })

      const result = await ratingService.rateBillingPeriod({
        projectId,
        customerId,
        featureSlug,
        now,
        grants: [trialGrant],
        usageData: [{ featureSlug, usage: 5 }],
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.length).toBe(1)
      expect(result.val![0]!.isTrial).toBe(true)
      expect(result.val![0]!.prorate).toBe(0)
    })
  })

  describe("resolveBillingWindow", () => {
    const baseEntitlement = {
      featureSlug,
      featureType: "usage" as const,
      meterConfig: null,
      effectiveAt: now - 60_000,
      expiresAt: now + 60_000,
      resetConfig: null,
    } as unknown as Omit<Entitlement, "id">

    it("returns explicit startAt/endAt when provided", () => {
      const result = ratingService.resolveBillingWindow({
        entitlement: baseEntitlement,
        startAt: 1000,
        endAt: 2000,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toEqual({ billingStartAt: 1000, billingEndAt: 2000 })
    })

    it("returns error when startAt >= endAt", () => {
      const result = ratingService.resolveBillingWindow({
        entitlement: baseEntitlement,
        startAt: 2000,
        endAt: 1000,
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toContain("must be before")
    })

    it("falls back to grant effective dates when no resetConfig and now is provided", () => {
      const result = ratingService.resolveBillingWindow({
        entitlement: baseEntitlement,
        now,
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.billingStartAt).toBe(baseEntitlement.effectiveAt)
    })
  })

  describe("entitlement passthrough", () => {
    it("skips computeEntitlementState when entitlement is provided", async () => {
      const usageGrant = makeGrant({
        id: "ent_pass",
        featureType: "usage",
        config: {
          usageMode: "unit",
          price: makePrice(100, "1.00"),
        },
      })

      const entitlement = {
        featureSlug,
        featureType: "usage" as const,
        meterConfig: {
          eventId: "evt",
          eventSlug: featureSlug,
          aggregationMethod: "sum" as const,
          aggregationField: "value",
        },
        effectiveAt: now - 60_000,
        expiresAt: now + 60_000,
        resetConfig: null,
      } as unknown as Omit<Entitlement, "id">

      const result = await ratingService.rateBillingPeriod({
        projectId,
        customerId,
        featureSlug,
        now,
        grants: [usageGrant],
        entitlement,
        usageData: [{ featureSlug, usage: 3 }],
      })

      expect(result.err).toBeUndefined()
      expect(mockComputeEntitlementState).not.toHaveBeenCalled()
      expect(result.val!.length).toBe(1)
    })
  })

  describe("error paths", () => {
    it("returns error when computeEntitlementState fails", async () => {
      const usageGrant = makeGrant({
        id: "err_ent",
        featureType: "usage",
        config: {
          usageMode: "unit",
          price: makePrice(100, "1.00"),
        },
      })

      mockComputeEntitlementState.mockResolvedValueOnce(
        Err(new UnPriceRatingError({ message: "entitlement computation failed" }))
      )

      const result = await ratingService.rateBillingPeriod({
        projectId,
        customerId,
        featureSlug,
        now,
        grants: [usageGrant],
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toContain("entitlement computation failed")
    })

    it("returns error when grant fetch fails", async () => {
      mockGetGrantsForCustomer.mockResolvedValueOnce(
        Err(new UnPriceRatingError({ message: "grants not found" }))
      )

      const result = await ratingService.rateBillingPeriod({
        projectId,
        customerId,
        featureSlug,
        now,
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toContain("grants not found")
    })
  })

  describe("rateIncrementalUsage shared data", () => {
    it("computes entitlement only once for both before and after", async () => {
      const usageGrant = makeGrant({
        id: "incr_shared",
        featureType: "usage",
        config: {
          usageMode: "unit",
          price: makePrice(100, "1.00"),
        },
      })

      const result = await ratingService.rateIncrementalUsage({
        projectId,
        customerId,
        featureSlug,
        now,
        usageBefore: 5,
        usageAfter: 10,
        grants: [usageGrant],
      })

      expect(result.err).toBeUndefined()
      // entitlement computed once (not twice — before and after share it)
      expect(mockComputeEntitlementState).toHaveBeenCalledTimes(1)
      expect(result.val!.usageDelta).toBe(5)
      expect(formatAmountForProvider(result.val!.deltaPrice.totalPrice.dinero).amount).toBe(500)
    })

    it("returns zero delta when no grants exist", async () => {
      const result = await ratingService.rateIncrementalUsage({
        projectId,
        customerId,
        featureSlug,
        now,
        usageBefore: 0,
        usageAfter: 5,
        grants: [],
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.before).toEqual([])
      expect(result.val!.after).toEqual([])
      expect(formatAmountForProvider(result.val!.deltaPrice.totalPrice.dinero).amount).toBe(0)
    })
  })
})
