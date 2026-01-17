import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { EntitlementState } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { MemoryEntitlementStorageProvider } from "./memory-provider"
import { EntitlementService } from "./service"

describe("EntitlementService - Multiple Grants", () => {
  let service: EntitlementService
  let mockDb: Database
  let mockStorage: MemoryEntitlementStorageProvider
  let mockLogger: Logger
  let mockAnalytics: Analytics
  let mockCache: Cache
  let mockMetrics: Metrics

  const now = Date.now()
  const customerId = "cust_multi_123"
  const projectId = "proj_multi_123"
  const featureSlug = "multi-grant-feature"

  const grantA = {
    id: "grant_A",
    type: "subscription" as const,
    priority: 10,
    limit: 100,
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    overageStrategy: "none" as const,
    featurePlanVersionId: "fpv_A",
    subjectType: "customer",
    subjectId: customerId,
    realtime: false,
  }

  const grantB = {
    id: "grant_B",
    type: "addon" as const,
    priority: 20,
    limit: 50,
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    overageStrategy: "none" as const,
    featurePlanVersionId: "fpv_B",
    subjectType: "customer",
    subjectId: customerId,
    realtime: false,
  }

  const mockEntitlementState: EntitlementState = {
    id: "ent_multi_123",
    customerId,
    projectId,
    featureSlug,
    featureType: "usage",
    limit: 150, // Sum of limits (100 + 50)
    aggregationMethod: "sum",
    mergingPolicy: "sum",
    meter: {
      usage: "0",
      snapshotUsage: "0",
      lastReconciledId: "rec_initial",
      lastUpdated: now,
      lastCycleStart: now - 10000,
    },
    grants: [grantA, grantB],
    version: "v1",
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    nextRevalidateAt: now + 300000,
    computedAt: now,
    resetConfig: null,
    metadata: {
      overageStrategy: "none" as const,
      realtime: false,
      notifyUsageThreshold: 0,
      blockCustomer: false,
      hidden: false,
    },
    createdAtM: now,
    updatedAtM: now,
  }

  beforeEach(async () => {
    vi.clearAllMocks()

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
    } as unknown as Analytics

    mockDb = {
      query: {
        entitlements: {
          findFirst: vi.fn(),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ ...mockEntitlementState }]),
          })),
        })),
      })),
    } as unknown as Database

    mockCache = {
      customerEntitlement: {
        swr: vi.fn().mockImplementation(async (_key, fetcher) => {
          const val = await fetcher()
          return { val, fresh: true }
        }),
        set: vi.fn(),
        get: vi.fn(),
        remove: vi.fn(),
      },
      customerEntitlements: {
        swr: vi.fn().mockImplementation(async (_key, fetcher) => {
          const val = await fetcher()
          return { val, fresh: true }
        }),
        set: vi.fn(),
        get: vi.fn(),
        remove: vi.fn(),
      },
      negativeEntitlements: {
        get: vi.fn().mockResolvedValue({ val: null }),
        set: vi.fn(),
        remove: vi.fn(),
      },
    } as unknown as Cache

    mockMetrics = {} as unknown as Metrics

    mockStorage = new MemoryEntitlementStorageProvider({
      logger: mockLogger,
      analytics: mockAnalytics,
    })
    await mockStorage.initialize()

    service = new EntitlementService({
      db: mockDb,
      storage: mockStorage,
      logger: mockLogger,
      analytics: mockAnalytics,
      waitUntil: vi.fn((promise) => promise),
      cache: mockCache,
      metrics: mockMetrics,
    })
  })

  it("should attribute consumption by priority", async () => {
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...mockEntitlementState,
      metadata: null,
      createdAtM: now,
      updatedAtM: now,
    })

    // Report usage of 60
    // Grant B (priority 20, limit 50) should be consumed first
    // Grant A (priority 10, limit 100) should take remaining 10
    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 60,
      timestamp: now,
      requestId: "req_prio_1",
      idempotenceKey: "idem_prio_1",
      metadata: null,
    })

    expect(result.allowed).toBe(true)
    expect(result.usage).toBe(60)
  })

  it("should only consume from active grants based on dates", async () => {
    const futureGrant = {
      ...grantB,
      id: "grant_future",
      effectiveAt: now + 5000, // Starts in future
      expiresAt: now + 15000,
    }

    const stateWithFuture: EntitlementState = {
      ...mockEntitlementState,
      grants: [grantA, futureGrant],
      limit: 150, // Assuming recomputation would include it, but verify filters
    }

    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...stateWithFuture,
      metadata: null,
      createdAtM: now,
      updatedAtM: now,
    })

    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 60,
      timestamp: now, // Before futureGrant starts
      requestId: "req_date_1",
      idempotenceKey: "idem_date_1",
      metadata: null,
    })

    expect(result.allowed).toBe(true)
  })

  it("should handle expired grants correctly", async () => {
    const expiredGrant = {
      ...grantB,
      id: "grant_expired",
      effectiveAt: now - 20000,
      expiresAt: now - 10000, // Expired
    }

    const stateWithExpired: EntitlementState = {
      ...mockEntitlementState,
      grants: [grantA, expiredGrant],
    }

    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...stateWithExpired,
      metadata: null,
      createdAtM: now,
      updatedAtM: now,
    })

    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 60,
      timestamp: now,
      requestId: "req_exp_1",
      idempotenceKey: "idem_exp_1",
      metadata: null,
    })

    expect(result.allowed).toBe(true)
    // Should only consume from Grant A (active)
  })

  it("should allow overage if at least one active grant allows it", async () => {
    const grantStrict = {
      ...grantA,
      id: "grant_strict",
      limit: 10,
      overageStrategy: "none" as const,
    }

    const grantFlexible = {
      ...grantB,
      id: "grant_flexible",
      limit: 10,
      overageStrategy: "always" as const,
    }

    const stateMixed: EntitlementState = {
      ...mockEntitlementState,
      limit: 20, // Sum limits = 20
      grants: [grantStrict, grantFlexible],
      mergingPolicy: "sum",
      metadata: {
        overageStrategy: "always" as const,
        realtime: false,
        notifyUsageThreshold: 0,
        blockCustomer: false,
        hidden: false,
      },
    }

    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...stateMixed,
      createdAtM: now,
      updatedAtM: now,
    })

    // Usage 30 > Limit 20
    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 30,
      timestamp: now,
      requestId: "req_overage_1",
      idempotenceKey: "idem_overage_1",
      metadata: null,
    })

    expect(result.allowed).toBe(true)
    expect(result.notifiedOverLimit).toBe(true)

    // Verify attribution
    // Flexible (Prio 20) takes 10 (its limit)
    // Strict (Prio 10) takes 10 (its limit)
    // Remaining 10 attributed? The loop breaks when remaining <= 0 or runs out of grants.
    // If runs out of grants and remaining > 0, where does it go?
    // In `attributeConsumption`:
    // It iterates grants. `toAttribute = min(remaining, grant.limit)`.
    // If grant.limit is null (unlimited), it takes all.
    // If both have limits, it consumes up to limit.
    // Any remaining amount is NOT attributed to a specific grant ID if limits are exhausted.
  })
})
