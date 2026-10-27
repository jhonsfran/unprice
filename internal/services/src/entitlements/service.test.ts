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
    } as never,
    metrics: {} as never,
    customerService: {} as never,
    grantsManager: {} as never,
    billingService: {} as never,
  })
}

describe("EntitlementService access control list", () => {
  function createAclService({
    customerRow,
    subscriptionRow,
  }: {
    customerRow: { active: boolean; metadata: { usageLimitReached?: boolean } | null } | null
    subscriptionRow: { status: string } | null
  }) {
    const limit = vi
      .fn()
      .mockResolvedValueOnce(customerRow ? [customerRow] : [])
      .mockResolvedValueOnce(subscriptionRow ? [subscriptionRow] : [])
    const where = vi.fn().mockReturnValue({ limit })
    const from = vi.fn().mockReturnValue({ where })
    const select = vi.fn().mockReturnValue({ from })

    const cache = {
      accessControlList: {
        swr: vi.fn().mockImplementation(async (key: string, loader: (key: string) => unknown) => ({
          val: await loader(key),
        })),
      },
    }

    const service = new EntitlementService({
      db: { select } as never,
      logger: { error: vi.fn(), set: vi.fn(), warn: vi.fn() } as never,
      analytics: {} as never,
      waitUntil: vi.fn(),
      cache: cache as never,
      metrics: {} as never,
      customerService: {} as never,
      grantsManager: {} as never,
      billingService: {} as never,
    })

    return { service }
  }

  it("reads the durable usage-limit flag from customer metadata on rebuild", async () => {
    const { service } = createAclService({
      customerRow: { active: true, metadata: { usageLimitReached: true } },
      subscriptionRow: { status: "active" },
    })

    const acl = await service.getAccessControlList({
      customerId: "cus_123",
      projectId: "proj_123",
    })

    expect(acl).toEqual({
      customerUsageLimitReached: true,
      customerDisabled: false,
      subscriptionStatus: "active",
    })
  })

  it("defaults the usage-limit flag to false when metadata has no flag", async () => {
    const { service } = createAclService({
      customerRow: { active: false, metadata: null },
      subscriptionRow: null,
    })

    const acl = await service.getAccessControlList({
      customerId: "cus_123",
      projectId: "proj_123",
    })

    expect(acl).toEqual({
      customerUsageLimitReached: false,
      customerDisabled: true,
      subscriptionStatus: null,
    })
  })
})
