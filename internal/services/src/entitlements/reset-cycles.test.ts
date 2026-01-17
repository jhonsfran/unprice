import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { EntitlementState } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { createClock, createMockEntitlementState } from "../test-utils"
import { MemoryEntitlementStorageProvider } from "./memory-provider"
import { EntitlementService } from "./service"

describe("EntitlementService - Reset Cycles", () => {
  let service: EntitlementService
  let mockDb: Database
  let mockStorage: MemoryEntitlementStorageProvider
  let mockLogger: Logger
  let mockAnalytics: Analytics
  let mockCache: Cache
  let mockMetrics: Metrics

  const customerId = "cust_reset_123"
  const projectId = "proj_reset_123"
  const featureSlug = "reset-feature"

  // Dates
  const jan1 = new Date("2024-01-01T00:00:00Z").getTime()
  const jan2 = new Date("2024-01-02T00:00:00Z").getTime()
  const jan3 = new Date("2024-01-03T00:00:00Z").getTime()
  const jan9 = new Date("2024-01-09T00:00:00Z").getTime()
  const jan10 = new Date("2024-01-10T00:00:00Z").getTime()

  let _clock = createClock(jan1)

  const mockEntitlementState = createMockEntitlementState({
    id: "ent_reset_123",
    customerId,
    projectId,
    featureSlug,
    limit: 100, // Weekly limit
    createdAtM: jan1,
    updatedAtM: jan1,
    meter: {
      usage: "0",
      snapshotUsage: "0",
      lastReconciledId: "",
      lastUpdated: jan1,
      lastCycleStart: jan1,
    },
    grants: [
      {
        id: "grant_reset_1",
        type: "subscription",
        effectiveAt: jan1,
        expiresAt: jan1 + 30 * 24 * 60 * 60 * 1000, // 30 days
        limit: 100,
        priority: 10,
      },
    ],
    effectiveAt: jan1,
    expiresAt: jan1 + 30 * 24 * 60 * 60 * 1000,
    nextRevalidateAt: jan1 + 300000,
    computedAt: jan1,
    resetConfig: {
      name: "weekly-reset",
      resetInterval: "week",
      resetIntervalCount: 1,
      resetAnchor: 1, // Monday
      planType: "recurring",
    },
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    _clock = createClock(jan1)

    mockLogger = {
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

  it("should reset usage when entering a new cycle", async () => {
    // Initial State hit the database on cache miss
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...mockEntitlementState,
      createdAtM: jan1,
      updatedAtM: jan1,
    })

    // 1. Week 1 - Usage 50
    const res1 = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 50,
      timestamp: jan2,
      requestId: "req_1",
      idempotenceKey: "idem_1",
      metadata: null,
    })

    expect(res1.allowed).toBe(true)
    expect(res1.usage).toBe(50)

    // Verify storage
    let stored = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(stored.val?.meter.usage).toBe("50")

    // mock the entitlement in cache
    vi.spyOn(mockCache.customerEntitlement, "swr").mockResolvedValue(Ok(mockEntitlementState))

    // 2. Week 1 - Usage 10 (Total 60)
    const res2 = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 10,
      timestamp: jan3,
      requestId: "req_2",
      idempotenceKey: "idem_2",
      metadata: null,
    })

    expect(res2.allowed).toBe(true)
    expect(res2.usage).toBe(60)

    stored = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(stored.val?.meter.usage).toBe("60")

    // 3. Week 2 - Usage 20 (Should Reset)
    // Week 2 starts Jan 8
    const res3 = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 20,
      timestamp: jan9,
      requestId: "req_3",
      idempotenceKey: "idem_3",
      metadata: null,
    })
    expect(res3.allowed).toBe(true)
    // Should be 20 because of reset
    expect(res3.usage).toBe(20)

    stored = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(stored.val?.meter.usage).toBe("20")

    // 4. Week 2 - Usage 10 (Total 30 in Week 2)
    // This confirms we don't reset AGAIN within Week 2
    const res4 = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 10,
      timestamp: jan10,
      requestId: "req_4",
      idempotenceKey: "idem_4",
      metadata: null,
    })
    expect(res4.allowed).toBe(true)
    expect(res4.usage).toBe(30)

    stored = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(stored.val?.meter.usage).toBe("30")
  })

  it("should handle daily reset over a month period and expire entitlement", async () => {
    const monthStart = jan1
    const monthEnd = jan1 + 30 * 24 * 60 * 60 * 1000 // 30 days

    const dailyResetState = createMockEntitlementState({
      id: "ent_daily_reset",
      customerId,
      projectId,
      featureSlug,
      resetConfig: {
        name: "daily-reset",
        resetInterval: "day",
        resetIntervalCount: 1,
        resetAnchor: 0, // 00:00:00
        planType: "recurring",
      },
      limit: 10, // Daily limit of 10
      effectiveAt: monthStart,
      expiresAt: monthEnd,
      meter: {
        usage: "0",
        snapshotUsage: "0",
        lastReconciledId: "",
        lastUpdated: monthStart,
        lastCycleStart: monthStart,
      },
      grants: [
        {
          id: "grant_daily",
          type: "subscription",
          priority: 10,
          limit: 10,
          effectiveAt: monthStart,
          expiresAt: monthEnd,
        },
      ],
    })

    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...dailyResetState,
      createdAtM: monthStart,
      updatedAtM: monthStart,
    } as EntitlementState)

    vi.spyOn(mockCache.customerEntitlement, "swr").mockResolvedValue(Ok(dailyResetState))

    // Simulate 30 days of usage
    for (let day = 0; day < 30; day++) {
      // Set timestamp to mid-day (12:00)
      const currentTimestamp = monthStart + day * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000

      // Report usage within limit
      const res = await service.reportUsage({
        customerId,
        projectId,
        featureSlug,
        usage: 5,
        timestamp: currentTimestamp,
        requestId: `req_day_${day}`,
        idempotenceKey: `idem_day_${day}`,
        metadata: null,
      })

      expect(res.allowed).toBe(true)
      expect(res.usage).toBe(5) // Should be 5 every day due to reset

      // Verify storage state
      const stored = await mockStorage.get({ customerId, projectId, featureSlug })
      expect(stored.val?.meter.usage).toBe("5")
    }

    // Test expiration
    const expiredTimestamp = monthEnd + 1000 // 1 second after expiration

    // Spy on grants manager to verify recomputation attempt
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const computeGrantsSpy = vi.spyOn((service as any).grantsManager, "computeGrantsForCustomer")
    // Mock return empty to simulate no valid renewal found
    computeGrantsSpy.mockResolvedValue(Ok([]))

    const resExpired = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 50,
      timestamp: expiredTimestamp,
      requestId: "req_expired",
      idempotenceKey: "idem_expired",
      metadata: null,
    })

    expect(computeGrantsSpy).toHaveBeenCalledWith({
      customerId,
      projectId,
      now: expiredTimestamp,
      featureSlug,
    })

    // Should fail with ENTITLEMENT_NOT_FOUND because recomputation found no grants
    expect(resExpired.allowed).toBe(false)
    expect(resExpired.deniedReason).toBe("ENTITLEMENT_NOT_FOUND")
  })
})
