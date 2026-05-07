import { currencies, dinero } from "@unprice/db/utils"
import { Ok } from "@unprice/error"
import { toDecimal } from "dinero.js"
import { describe, expect, it, vi } from "vitest"
import { RatingService } from "./service"

describe("RatingService", () => {
  it("resolves explicit billing windows without grant resolution", () => {
    const service = new RatingService({
      analytics: {} as never,
      grantsManager: {} as never,
      logger: { warn: vi.fn() } as never,
    })

    const result = service.resolveBillingWindow({
      entitlement: {
        effectiveAt: 1,
        expiresAt: null,
        resetConfig: null,
        meterConfig: null,
        featureType: "usage",
      },
      startAt: 10,
      endAt: 20,
    })

    expect(result.val).toEqual({ billingStartAt: 10, billingEndAt: 20 })
  })

  it("loads grants for customer feature when grants are not provided", async () => {
    const listGrantsForCustomerFeature = vi.fn().mockResolvedValue(Ok([]))
    const service = new RatingService({
      analytics: {} as never,
      grantsManager: { listGrantsForCustomerFeature } as never,
      logger: { warn: vi.fn() } as never,
    })

    const result = await service.rateBillingPeriod({
      projectId: "proj_123",
      customerId: "cus_123",
      featureSlug: "events",
      startAt: 10,
      endAt: 20,
    })

    expect(result.err).toBeUndefined()
    expect(listGrantsForCustomerFeature).toHaveBeenCalledWith({
      projectId: "proj_123",
      customerId: "cus_123",
      featureSlug: "events",
      startAt: 10,
      endAt: 20,
    })
  })

  it("resolves dayOfCreation reset anchors before monthly rating", async () => {
    const service = new RatingService({
      analytics: {} as never,
      grantsManager: {} as never,
      logger: { warn: vi.fn() } as never,
    })
    const effectiveAt = Date.UTC(2026, 4, 6, 19, 35, 33)

    const result = await service.rateBillingPeriod({
      projectId: "proj_123",
      customerId: "cus_123",
      featureSlug: "events",
      startAt: effectiveAt,
      endAt: Date.UTC(2026, 5, 6, 0, 0, 0),
      usageData: [{ featureSlug: "events", usage: 1 }],
      grants: [
        {
          id: "grnt_123",
          projectId: "proj_123",
          customerEntitlementId: "ce_123",
          type: "subscription",
          priority: 10,
          allowanceUnits: 100,
          effectiveAt,
          expiresAt: null,
          metadata: null,
          createdAtM: effectiveAt,
          updatedAtM: effectiveAt,
          customerEntitlement: {
            id: "ce_123",
            projectId: "proj_123",
            customerId: "cus_123",
            featurePlanVersionId: "fv_123",
            subscriptionId: "sub_123",
            subscriptionPhaseId: "sp_123",
            subscriptionItemId: "si_123",
            effectiveAt,
            expiresAt: null,
            overageStrategy: "none",
            metadata: null,
            createdAtM: effectiveAt,
            updatedAtM: effectiveAt,
            featurePlanVersion: {
              id: "fv_123",
              projectId: "proj_123",
              planVersionId: "pv_123",
              type: "feature",
              featureId: "feat_123",
              featureType: "usage",
              unitOfMeasure: "events",
              config: {
                price: {
                  dinero: dinero({ amount: 1, currency: currencies.EUR, scale: 3 }).toJSON(),
                  displayAmount: "0.001",
                },
                usageMode: "unit",
                units: 1,
              },
              billingConfig: {
                name: "monthly",
                billingInterval: "month",
                billingIntervalCount: 1,
                billingAnchor: "dayOfCreation",
                planType: "recurring",
              },
              resetConfig: {
                name: "monthly",
                resetInterval: "month",
                resetIntervalCount: 1,
                resetAnchor: "dayOfCreation",
                planType: "recurring",
              },
              meterConfig: {
                aggregationMethod: "sum",
                aggregationField: "value",
                eventId: "evt_123",
                eventSlug: "events",
              },
              metadata: null,
              order: 0,
              defaultQuantity: null,
              limit: null,
              createdAtM: effectiveAt,
              updatedAtM: effectiveAt,
              feature: {
                id: "feat_123",
                projectId: "proj_123",
                slug: "events",
                code: 1,
                title: "Events",
                description: null,
                unitOfMeasure: "events",
                meterConfig: null,
                createdAtM: effectiveAt,
                updatedAtM: effectiveAt,
              },
            },
          },
        },
      ],
    })

    expect(result.err).toBeUndefined()
  })

  it("charges a full flat monthly fee when the subscription starts mid-day", async () => {
    const service = new RatingService({
      analytics: {} as never,
      grantsManager: {} as never,
      logger: { warn: vi.fn() } as never,
    })
    const effectiveAt = Date.UTC(2026, 4, 7, 12, 5, 0)

    const result = await service.rateBillingPeriod({
      projectId: "proj_123",
      customerId: "cus_123",
      featureSlug: "access",
      startAt: Date.UTC(2026, 4, 7, 0, 0, 0),
      endAt: Date.UTC(2026, 5, 7, 0, 0, 0),
      usageData: [{ featureSlug: "access", usage: 1 }],
      grants: [
        {
          id: "grnt_123",
          projectId: "proj_123",
          customerEntitlementId: "ce_123",
          type: "subscription",
          priority: 10,
          allowanceUnits: 1,
          effectiveAt,
          expiresAt: null,
          metadata: null,
          createdAtM: effectiveAt,
          updatedAtM: effectiveAt,
          customerEntitlement: {
            id: "ce_123",
            projectId: "proj_123",
            customerId: "cus_123",
            featurePlanVersionId: "fv_123",
            subscriptionId: "sub_123",
            subscriptionPhaseId: "sp_123",
            subscriptionItemId: "si_123",
            effectiveAt,
            expiresAt: null,
            overageStrategy: "none",
            metadata: null,
            createdAtM: effectiveAt,
            updatedAtM: effectiveAt,
            featurePlanVersion: {
              id: "fv_123",
              projectId: "proj_123",
              planVersionId: "pv_123",
              type: "feature",
              featureId: "feat_123",
              featureType: "flat",
              unitOfMeasure: "seat",
              config: {
                price: {
                  dinero: dinero({ amount: 9900, currency: currencies.EUR }).toJSON(),
                  displayAmount: "99.00",
                },
              },
              billingConfig: {
                name: "monthly",
                billingInterval: "month",
                billingIntervalCount: 1,
                billingAnchor: "dayOfCreation",
                planType: "recurring",
              },
              resetConfig: {
                name: "monthly",
                resetInterval: "month",
                resetIntervalCount: 1,
                resetAnchor: "dayOfCreation",
                planType: "recurring",
              },
              meterConfig: null,
              metadata: null,
              order: 0,
              defaultQuantity: null,
              limit: null,
              createdAtM: effectiveAt,
              updatedAtM: effectiveAt,
              feature: {
                id: "feat_123",
                projectId: "proj_123",
                slug: "access",
                code: 1,
                title: "Access Pro",
                description: null,
                unitOfMeasure: "seat",
                meterConfig: null,
                createdAtM: effectiveAt,
                updatedAtM: effectiveAt,
              },
            },
          },
        },
      ],
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toHaveLength(1)
    expect(result.val![0]!.prorate).toBe(1)
    expect(toDecimal(result.val![0]!.price.totalPrice.dinero)).toBe("99.00")
  })

  it("filters usage billing by the grant period key", async () => {
    const getUsageBillingFeatures = vi.fn().mockResolvedValue(
      Ok([
        {
          featureSlug: "events",
          usage: 5,
        },
      ])
    )
    const service = new RatingService({
      analytics: { getUsageBillingFeatures } as never,
      grantsManager: {} as never,
      logger: { warn: vi.fn(), error: vi.fn() } as never,
    })
    const periodStart = Date.UTC(2026, 4, 7, 0, 0, 0)
    const effectiveAt = Date.UTC(2026, 4, 7, 12, 5, 0)

    const result = await service.rateBillingPeriod({
      projectId: "proj_123",
      customerId: "cus_123",
      featureSlug: "events",
      startAt: periodStart,
      endAt: Date.UTC(2026, 5, 7, 0, 0, 0),
      grants: [
        {
          id: "grnt_123",
          projectId: "proj_123",
          customerEntitlementId: "ce_123",
          type: "subscription",
          priority: 10,
          allowanceUnits: 100,
          effectiveAt,
          expiresAt: null,
          metadata: null,
          createdAtM: effectiveAt,
          updatedAtM: effectiveAt,
          customerEntitlement: {
            id: "ce_123",
            projectId: "proj_123",
            customerId: "cus_123",
            featurePlanVersionId: "fv_123",
            subscriptionId: "sub_123",
            subscriptionPhaseId: "sp_123",
            subscriptionItemId: "si_123",
            effectiveAt,
            expiresAt: null,
            overageStrategy: "none",
            metadata: null,
            createdAtM: effectiveAt,
            updatedAtM: effectiveAt,
            featurePlanVersion: {
              id: "fv_123",
              projectId: "proj_123",
              planVersionId: "pv_123",
              type: "feature",
              featureId: "feat_123",
              featureType: "usage",
              unitOfMeasure: "events",
              config: {
                price: {
                  dinero: dinero({ amount: 1, currency: currencies.EUR, scale: 3 }).toJSON(),
                  displayAmount: "0.001",
                },
                usageMode: "unit",
                units: 1,
              },
              billingConfig: {
                name: "monthly",
                billingInterval: "month",
                billingIntervalCount: 1,
                billingAnchor: "dayOfCreation",
                planType: "recurring",
              },
              resetConfig: {
                name: "monthly",
                resetInterval: "month",
                resetIntervalCount: 1,
                resetAnchor: "dayOfCreation",
                planType: "recurring",
              },
              meterConfig: {
                aggregationMethod: "sum",
                aggregationField: "value",
                eventId: "evt_123",
                eventSlug: "events",
              },
              metadata: null,
              order: 0,
              defaultQuantity: null,
              limit: null,
              createdAtM: effectiveAt,
              updatedAtM: effectiveAt,
              feature: {
                id: "feat_123",
                projectId: "proj_123",
                slug: "events",
                code: 1,
                title: "Events",
                description: null,
                unitOfMeasure: "events",
                meterConfig: null,
                createdAtM: effectiveAt,
                updatedAtM: effectiveAt,
              },
            },
          },
        },
      ],
    })

    expect(result.err).toBeUndefined()
    expect(getUsageBillingFeatures).toHaveBeenCalledWith(
      expect.objectContaining({
        customerEntitlementIds: ["ce_123"],
        periodKeys: [`month:${periodStart}`],
      })
    )
  })
})
