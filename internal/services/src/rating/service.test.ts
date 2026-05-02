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
        limit: 100,
        mergingPolicy: "replace",
        effectiveAt: 1,
        expiresAt: null,
        resetConfig: null,
        meterConfig: null,
        featureType: "usage",
        unitOfMeasure: "units",
        grants: [],
        featureSlug: "api_calls",
        customerId: "cus_123",
        projectId: "proj_123",
        isCurrent: true,
        createdAtM: 0,
        updatedAtM: 0,
        metadata: null,
      },
      startAt: 10,
      endAt: 20,
    })

    expect(result.val).toEqual({ billingStartAt: 10, billingEndAt: 20 })
  })
})
