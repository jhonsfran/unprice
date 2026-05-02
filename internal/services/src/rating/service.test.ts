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
})
