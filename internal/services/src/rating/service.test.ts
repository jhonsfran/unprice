import { currencies, dinero } from "@unprice/db/utils"
import { Ok } from "@unprice/error"
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
})
