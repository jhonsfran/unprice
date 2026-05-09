import { describe, expect, it, vi } from "vitest"
import { EntitlementService } from "./service"

describe("EntitlementService customer entitlement invariants", () => {
  it("rejects overlapping active entitlements for the same customer feature", async () => {
    const insert = vi.fn()
    const db = {
      query: {
        customerEntitlements: {
          findFirst: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([
            {
              id: "ce_existing",
              featurePlanVersion: {
                featureId: "feature_api_calls",
              },
            },
          ]),
        },
        planVersionFeatures: {
          findFirst: vi.fn().mockResolvedValue({
            id: "fpv_new",
            featureId: "feature_api_calls",
          }),
        },
      },
      insert,
    }
    const service = createEntitlementService(db)

    const result = await service.createCustomerEntitlement({
      entitlement: {
        id: "ce_new",
        projectId: "proj_123",
        customerId: "cus_123",
        featurePlanVersionId: "fpv_new",
        subscriptionId: "sub_123",
        subscriptionPhaseId: "phase_123",
        subscriptionItemId: "item_123",
        effectiveAt: 1000,
        expiresAt: null,
        overageStrategy: "none",
        metadata: null,
      },
    })

    expect(result.err?.message).toContain(
      "Customer already has an active entitlement for this feature"
    )
    expect(insert).not.toHaveBeenCalled()
  })

  it("allows an adjacent entitlement for the same customer feature", async () => {
    const returning = vi.fn().mockResolvedValue([
      {
        id: "ce_new",
        projectId: "proj_123",
        customerId: "cus_123",
      },
    ])
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning })
    const values = vi.fn().mockReturnValue({ onConflictDoNothing })
    const insert = vi.fn().mockReturnValue({ values })
    const db = {
      query: {
        customerEntitlements: {
          findFirst: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
        },
        planVersionFeatures: {
          findFirst: vi.fn().mockResolvedValue({
            id: "fpv_new",
            featureId: "feature_api_calls",
          }),
        },
      },
      insert,
    }
    const service = createEntitlementService(db)

    const result = await service.createCustomerEntitlement({
      entitlement: {
        id: "ce_new",
        projectId: "proj_123",
        customerId: "cus_123",
        featurePlanVersionId: "fpv_new",
        subscriptionId: "sub_123",
        subscriptionPhaseId: "phase_123",
        subscriptionItemId: "item_123",
        effectiveAt: 2000,
        expiresAt: 3000,
        overageStrategy: "none",
        metadata: null,
      },
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.id).toBe("ce_new")
    expect(insert).toHaveBeenCalledTimes(1)
  })
})

function createEntitlementService(db: unknown): EntitlementService {
  const logger = {
    error: vi.fn(),
    set: vi.fn(),
    warn: vi.fn(),
  }

  return new EntitlementService({
    db: db as never,
    logger: logger as never,
    analytics: {} as never,
    waitUntil: vi.fn(),
    cache: {
      accessControlList: {},
      getCurrentUsage: {},
    } as never,
    metrics: {} as never,
    customerService: {} as never,
    grantsManager: {} as never,
    billingService: {} as never,
  })
}
