import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { currencies, dinero } from "@unprice/db/utils"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { createClock, createMockEntitlementState } from "../test-utils"
import { MemoryEntitlementStorageProvider } from "./memory-provider"
import { EntitlementService } from "./service"

describe("EntitlementService - Flat Features", () => {
  let service: EntitlementService
  let mockDb: Database
  let mockStorage: MemoryEntitlementStorageProvider
  let mockLogger: Logger
  let mockAnalytics: Analytics
  let mockCache: Cache
  let mockMetrics: Metrics

  const now = Date.now()
  const clock = createClock(now)
  const customerId = "cust_123"
  const projectId = "proj_123"
  const featureSlug = "flat-feature"
  const mockEntitlementState = createMockEntitlementState({
    id: "ent_flat",
    customerId,
    projectId,
    featureSlug,
    featureType: "flat",
    limit: 100,
    grants: [
      {
        id: "grant_flat",
        type: "subscription",
        effectiveAt: now - 10000,
        expiresAt: now + 10000,
        limit: 100,
        priority: 10,
        config: {
          price: {
            dinero: dinero({ amount: 0, currency: currencies.USD }).toJSON(),
            displayAmount: "0",
          },
        },
        featurePlanVersionId: "fpv_123",
      },
    ],
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    clock.set(now)

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
      getFeaturesUsageCursor: vi
        .fn()
        .mockResolvedValue(Ok({ usage: 0, lastRecordId: "rec_initial" })),
    } as unknown as Analytics

    mockDb = {
      query: {
        entitlements: {
          findFirst: vi.fn().mockResolvedValue(mockEntitlementState),
        },
        customers: {
          findFirst: vi.fn().mockResolvedValue({ subscriptions: [] }),
        },
      },
    } as unknown as Database

    mockCache = {
      customerEntitlement: {
        swr: vi
          .fn()
          .mockImplementation(async (_key, fetcher) => ({ val: await fetcher(), fresh: true })),
        get: vi.fn(),
        set: vi.fn(),
        remove: vi.fn(),
      },
      customerEntitlements: {
        swr: vi
          .fn()
          .mockImplementation(async (_key, fetcher) => ({ val: await fetcher(), fresh: true })),
        set: vi.fn(),
        remove: vi.fn(),
      },
      negativeEntitlements: {
        get: vi.fn().mockResolvedValue({ val: null }),
        set: vi.fn(),
        remove: vi.fn(),
      },
      accessControlList: {
        get: vi.fn().mockResolvedValue({ val: null }),
        set: vi.fn(),
        swr: vi
          .fn()
          .mockImplementation(async (_key, fetcher) => ({ val: await fetcher(), fresh: true })), // Added mock implementation
      },
      getCurrentUsage: {
        remove: vi.fn(),
        set: vi.fn(),
        swr: vi.fn(),
      },
    } as unknown as Cache

    mockMetrics = {} as unknown as Metrics

    mockStorage = new MemoryEntitlementStorageProvider({
      logger: mockLogger,
      analytics: mockAnalytics,
    })
    await mockStorage.initialize()
    vi.spyOn(mockStorage, "insertUsageRecord")

    service = new EntitlementService({
      db: mockDb,
      storage: mockStorage,
      logger: mockLogger,
      analytics: mockAnalytics,
      waitUntil: (p) => p,
      cache: mockCache,
      metrics: mockMetrics,
    })
  })

  it("shouldn't allow reportUsage for flat features", async () => {
    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 1,
      timestamp: clock.now(),
      idempotenceKey: "key_flat",
      requestId: "req_flat",
      metadata: null,
    })

    expect(result.allowed).toBe(false)
    expect(result.deniedReason).toBe("FLAT_FEATURE_NOT_ALLOWED_REPORT_USAGE")
    expect(result.message).toBe("Flat feature not allowed to be reported")
  })
})
