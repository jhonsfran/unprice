import { currencies, dinero } from "@unprice/db/utils"
import type {
  BillingConfig,
  ConfigFeatureVersionType,
  FeatureType,
  GrantType,
  MeterConfig,
  ResetConfig,
} from "@unprice/db/validators"
import { toDecimal } from "dinero.js"
import { describe, expect, it, vi } from "vitest"
import { RatingService } from "./service"

/**
 * Helper to build a grant object with minimal boilerplate.
 */
function makeGrant(overrides: {
  id?: string
  type?: GrantType
  priority?: number
  allowanceUnits?: number | null
  effectiveAt: number
  expiresAt?: number | null
  featureType?: FeatureType
  featureSlug?: string
  config: ConfigFeatureVersionType
  resetConfig?: ResetConfig | null
  meterConfig?: MeterConfig | null
}) {
  const {
    id = "grnt_1",
    type = "subscription",
    priority = 10,
    allowanceUnits = null,
    effectiveAt,
    expiresAt = null,
    featureType = "usage",
    featureSlug = "events",
    config,
    resetConfig = null,
    meterConfig = featureType === "usage"
      ? {
          aggregationMethod: "sum",
          aggregationField: "value",
          eventId: "evt_1",
          eventSlug: featureSlug,
        }
      : null,
  } = overrides
  const billingConfig = {
    name: "monthly",
    billingInterval: "month",
    billingIntervalCount: 1,
    billingAnchor: "dayOfCreation",
    planType: "recurring",
  } satisfies BillingConfig

  return {
    id,
    projectId: "proj_1",
    customerEntitlementId: "ce_1",
    type,
    priority,
    allowanceUnits,
    effectiveAt,
    expiresAt,
    metadata: null,
    createdAtM: effectiveAt,
    updatedAtM: effectiveAt,
    customerEntitlement: {
      id: "ce_1",
      projectId: "proj_1",
      customerId: "cus_1",
      featurePlanVersionId: "fv_1",
      subscriptionId: "sub_1",
      subscriptionPhaseId: "sp_1",
      subscriptionItemId: "si_1",
      effectiveAt,
      expiresAt,
      overageStrategy: "none" as const,
      metadata: null,
      createdAtM: effectiveAt,
      updatedAtM: effectiveAt,
      featurePlanVersion: {
        id: "fv_1",
        projectId: "proj_1",
        planVersionId: "pv_1",
        type: "feature" as const,
        featureId: "feat_1",
        featureType,
        unitOfMeasure: featureSlug,
        config,
        billingConfig,
        resetConfig,
        meterConfig,
        metadata: null,
        order: 0,
        defaultQuantity: null,
        limit: null,
        createdAtM: effectiveAt,
        updatedAtM: effectiveAt,
        feature: {
          id: "feat_1",
          projectId: "proj_1",
          slug: featureSlug,
          code: 1,
          title: featureSlug,
          description: null,
          unitOfMeasure: featureSlug,
          meterConfig: null,
          createdAtM: effectiveAt,
          updatedAtM: effectiveAt,
        },
      },
    },
  }
}

function makeService() {
  return new RatingService({
    analytics: {} as never,
    grantsManager: {} as never,
    logger: { warn: vi.fn(), error: vi.fn() } as never,
  })
}

const CYCLE_START = Date.UTC(2026, 0, 1, 0, 0, 0) // Jan 1
const CYCLE_END = Date.UTC(2026, 1, 1, 0, 0, 0) // Feb 1

describe("RatingService - extended", () => {
  it("flat fee with full proration (factor=1) returns full price", async () => {
    const service = makeService()
    const effectiveAt = CYCLE_START

    const result = await service.rateBillingPeriod({
      projectId: "proj_1",
      customerId: "cus_1",
      featureSlug: "access",
      startAt: CYCLE_START,
      endAt: CYCLE_END,
      usageData: [{ featureSlug: "access", usage: 1 }],
      grants: [
        makeGrant({
          effectiveAt,
          featureType: "flat",
          featureSlug: "access",
          allowanceUnits: 1,
          config: {
            price: {
              dinero: dinero({ amount: 3100, currency: currencies.USD }).toJSON(),
              displayAmount: "31.00",
            },
          },
          meterConfig: null,
        }),
      ],
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toHaveLength(1)
    expect(result.val![0]!.prorate).toBe(1)
    expect(toDecimal(result.val![0]!.price.totalPrice.dinero)).toBe("31.00")
  })

  it("trial grant returns zero charge (prorate=0)", async () => {
    const service = makeService()
    const effectiveAt = CYCLE_START

    const result = await service.rateBillingPeriod({
      projectId: "proj_1",
      customerId: "cus_1",
      featureSlug: "access",
      startAt: CYCLE_START,
      endAt: CYCLE_END,
      usageData: [{ featureSlug: "access", usage: 1 }],
      grants: [
        makeGrant({
          type: "trial",
          effectiveAt,
          featureType: "flat",
          featureSlug: "access",
          allowanceUnits: 1,
          config: {
            price: {
              dinero: dinero({ amount: 5000, currency: currencies.USD }).toJSON(),
              displayAmount: "50.00",
            },
          },
          meterConfig: null,
        }),
      ],
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toHaveLength(1)
    expect(result.val![0]!.prorate).toBe(0)
    expect(result.val![0]!.isTrial).toBe(true)
    expect(toDecimal(result.val![0]!.price.totalPrice.dinero)).toBe("0.00")
  })

  it("usage with two grants in waterfall — first handles allowance, second covers overflow", async () => {
    const service = makeService()
    const effectiveAt = CYCLE_START

    const grant1 = makeGrant({
      id: "grnt_1",
      effectiveAt,
      priority: 10,
      allowanceUnits: 100,
      config: {
        price: {
          dinero: dinero({ amount: 10, currency: currencies.USD }).toJSON(),
          displayAmount: "0.10",
        },
        usageMode: "unit",
        units: 1,
      },
      resetConfig: null,
    })

    const grant2 = makeGrant({
      id: "grnt_2",
      effectiveAt,
      priority: 5,
      allowanceUnits: null, // unlimited
      config: {
        price: {
          dinero: dinero({ amount: 5, currency: currencies.USD }).toJSON(),
          displayAmount: "0.05",
        },
        usageMode: "unit",
        units: 1,
      },
      resetConfig: null,
    })
    // Give grant2 its own customer entitlement id so it's distinguishable
    grant2.customerEntitlement.id = "ce_2"
    grant2.customerEntitlementId = "ce_2"

    const result = await service.rateBillingPeriod({
      projectId: "proj_1",
      customerId: "cus_1",
      featureSlug: "events",
      startAt: CYCLE_START,
      endAt: CYCLE_END,
      usageData: [{ featureSlug: "events", usage: 150 }],
      grants: [grant1, grant2],
    })

    expect(result.err).toBeUndefined()
    expect(result.val!.length).toBeGreaterThanOrEqual(2)

    const charge1 = result.val!.find((c) => c.grantId === "grnt_1")
    const charge2 = result.val!.find((c) => c.grantId === "grnt_2")

    expect(charge1).toBeDefined()
    expect(charge2).toBeDefined()
    // First grant handles up to 100 units
    expect(charge1!.usage).toBe(100)
    // Second grant handles remaining 50
    expect(charge2!.usage).toBe(50)
  })

  it("partial proration — grant effective mid-cycle yields factor < 1", async () => {
    const service = makeService()
    // Grant starts halfway through the cycle
    const midCycle = Date.UTC(2026, 0, 16, 0, 0, 0) // Jan 16

    const result = await service.rateBillingPeriod({
      projectId: "proj_1",
      customerId: "cus_1",
      featureSlug: "access",
      startAt: CYCLE_START,
      endAt: CYCLE_END,
      usageData: [{ featureSlug: "access", usage: 1 }],
      grants: [
        makeGrant({
          effectiveAt: midCycle,
          featureType: "flat",
          featureSlug: "access",
          allowanceUnits: 1,
          config: {
            price: {
              dinero: dinero({ amount: 3100, currency: currencies.USD }).toJSON(),
              displayAmount: "31.00",
            },
          },
          meterConfig: null,
          resetConfig: {
            name: "monthly",
            resetInterval: "month",
            resetIntervalCount: 1,
            resetAnchor: "dayOfCreation",
            planType: "recurring",
          },
        }),
      ],
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toHaveLength(1)
    const prorate = result.val![0]!.prorate
    // Mid-cycle start should give a proration factor between 0 and 1 (exclusive)
    expect(prorate).toBeGreaterThan(0)
    expect(prorate).toBeLessThan(1)
  })

  it("rateIncrementalUsage — delta between before=0 and after=50 yields positive price", async () => {
    const service = makeService()
    const effectiveAt = CYCLE_START

    const grant = makeGrant({
      effectiveAt,
      priority: 1,
      allowanceUnits: null,
      config: {
        price: {
          dinero: dinero({ amount: 10, currency: currencies.USD }).toJSON(),
          displayAmount: "0.10",
        },
        usageMode: "unit",
        units: 1,
      },
      resetConfig: null,
    })

    const result = await service.rateIncrementalUsage({
      projectId: "proj_1",
      customerId: "cus_1",
      featureSlug: "events",
      usageBefore: 0,
      usageAfter: 50,
      startAt: CYCLE_START,
      endAt: CYCLE_END,
      grants: [grant],
    })

    expect(result.err).toBeUndefined()
    expect(result.val!.usageDelta).toBe(50)
    const delta = Number(toDecimal(result.val!.deltaPrice.totalPrice.dinero))
    expect(delta).toBeGreaterThan(0)
  })

  it("zero usage returns charges with zero price", async () => {
    const service = makeService()
    const effectiveAt = CYCLE_START

    const result = await service.rateBillingPeriod({
      projectId: "proj_1",
      customerId: "cus_1",
      featureSlug: "events",
      startAt: CYCLE_START,
      endAt: CYCLE_END,
      usageData: [{ featureSlug: "events", usage: 0 }],
      grants: [
        makeGrant({
          effectiveAt,
          priority: 1,
          allowanceUnits: 100,
          config: {
            price: {
              dinero: dinero({ amount: 10, currency: currencies.USD }).toJSON(),
              displayAmount: "0.10",
            },
            usageMode: "unit",
            units: 1,
          },
          resetConfig: null,
        }),
      ],
    })

    expect(result.err).toBeUndefined()
    // With zero usage, total price should be zero
    for (const charge of result.val!) {
      expect(toDecimal(charge.price.totalPrice.dinero)).toBe("0")
    }
  })

  it("no grants returns empty array", async () => {
    const service = makeService()

    const result = await service.rateBillingPeriod({
      projectId: "proj_1",
      customerId: "cus_1",
      featureSlug: "events",
      startAt: CYCLE_START,
      endAt: CYCLE_END,
      usageData: [{ featureSlug: "events", usage: 100 }],
      grants: [],
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual([])
  })

  it("tiered pricing through waterfall — multiple tiers with different unit prices", async () => {
    const service = makeService()
    const effectiveAt = CYCLE_START

    const result = await service.rateBillingPeriod({
      projectId: "proj_1",
      customerId: "cus_1",
      featureSlug: "events",
      startAt: CYCLE_START,
      endAt: CYCLE_END,
      usageData: [{ featureSlug: "events", usage: 150 }],
      grants: [
        makeGrant({
          effectiveAt,
          priority: 1,
          allowanceUnits: null,
          config: {
            tiers: [
              {
                firstUnit: 1,
                lastUnit: 100,
                unitPrice: {
                  dinero: dinero({ amount: 10, currency: currencies.USD }).toJSON(),
                  displayAmount: "0.10",
                },
                flatPrice: {
                  dinero: dinero({ amount: 0, currency: currencies.USD }).toJSON(),
                  displayAmount: "0.00",
                },
              },
              {
                firstUnit: 101,
                lastUnit: null,
                unitPrice: {
                  dinero: dinero({ amount: 5, currency: currencies.USD }).toJSON(),
                  displayAmount: "0.05",
                },
                flatPrice: {
                  dinero: dinero({ amount: 0, currency: currencies.USD }).toJSON(),
                  displayAmount: "0.00",
                },
              },
            ],
            usageMode: "tier",
            tierMode: "graduated",
          },
          resetConfig: null,
        }),
      ],
    })

    expect(result.err).toBeUndefined()
    expect(result.val!.length).toBeGreaterThanOrEqual(1)
    // Total should be 100*$0.10 + 50*$0.05 = $10.00 + $2.50 = $12.50
    const total = result.val!.reduce(
      (sum, c) => sum + Number(toDecimal(c.price.totalPrice.dinero)),
      0
    )
    expect(total).toBeCloseTo(12.5, 1)
  })
})
