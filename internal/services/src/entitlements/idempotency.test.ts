import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { createClock, createMockEntitlementState } from "../test-utils"
import { MemoryEntitlementStorageProvider } from "./memory-provider"
import { EntitlementService } from "./service"

describe("EntitlementService - Idempotency & Flush", () => {
  let service: EntitlementService
  let mockDb: Database
  let mockStorage: MemoryEntitlementStorageProvider
  let mockLogger: Logger
  let mockAnalytics: Analytics
  let mockCache: Cache
  let mockMetrics: Metrics

  const now = Date.now()
  const clock = createClock(now)
  const customerId = "cust_idem_123"
  const projectId = "proj_idem_123"
  const featureSlug = "idem-feature"

  const mockEntitlementState = createMockEntitlementState({
    id: "ent_idem_123",
    customerId,
    projectId,
    featureSlug,
    limit: 100,
    meter: {
      usage: "0",
      snapshotUsage: "0",
      lastReconciledId: "rec_initial",
      lastUpdated: now,
      lastCycleStart: now - 10000,
    },
    grants: [
      {
        id: "grant_idem_1",
        type: "subscription",
        effectiveAt: now - 10000,
        expiresAt: now + 10000,
        limit: 100,
        priority: 10,
      },
    ],
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    nextRevalidateAt: now + 300000,
    computedAt: now,
    createdAtM: now,
    updatedAtM: now,
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    clock.set(now)

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

  it("should handle reportUsage idempotency", async () => {
    // Setup DB mock
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...mockEntitlementState,
      createdAtM: now,
      updatedAtM: now,
    })

    const usageAmount = 5
    const idempotenceKey = "idem_key_123"

    // First call - should succeed and record usage
    const res1 = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: usageAmount,
      timestamp: clock.now(),
      requestId: "req_1",
      idempotenceKey,
      metadata: null,
    })
    expect(res1.allowed).toBe(true)
    expect(res1.usage).toBe(5)

    // Second call - SAME key
    const res2 = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: usageAmount, // Same usage
      timestamp: clock.now(),
      requestId: "req_2",
      idempotenceKey, // SAME key
      metadata: null,
    })

    // So usage WILL NOT increase because of idempotency check.
    expect(res2.allowed).toBe(true)
    expect(res2.usage).toBe(5) // Still 5 because of idempotency key check

    // Now let's flush and verify analytics only receives ONE event
    await service.flush()

    expect(mockAnalytics.ingestFeaturesUsage).toHaveBeenCalledTimes(1)
    // The argument to ingestFeaturesUsage should be an array with 1 element (deduplicated)
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const callArgs = (mockAnalytics.ingestFeaturesUsage as any).mock.calls[0][0]
    expect(callArgs).toHaveLength(1)
    expect(callArgs[0].idempotenceKey).toBe(idempotenceKey)
  })

  it("should flush verifications correctly", async () => {
    // Setup DB mock
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...mockEntitlementState,
      createdAtM: now,
      updatedAtM: now,
    })

    // Create multiple verifications
    for (let i = 0; i < 5; i++) {
      await service.verify({
        customerId,
        projectId,
        featureSlug,
        timestamp: clock.now() + i,
        requestId: `req_ver_${i}`,
        metadata: null,
        performanceStart: performance.now(),
      })
    }

    // Check storage has 5 verifications
    const pending = await mockStorage.getAllVerifications()
    expect(pending.val).toHaveLength(5)

    // Flush
    await service.flush()

    // Analytics should be called with 5 items
    expect(mockAnalytics.ingestFeaturesVerification).toHaveBeenCalledTimes(1)
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const callArgs = (mockAnalytics.ingestFeaturesVerification as any).mock.calls[0][0]
    expect(callArgs).toHaveLength(5)

    // Storage should be empty
    const remaining = await mockStorage.getAllVerifications()
    expect(remaining.val).toHaveLength(0)
  })

  it("should flush usage records correctly", async () => {
    // Setup DB mock
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...mockEntitlementState,
      createdAtM: now,
      updatedAtM: now,
    })

    // Generate distinct usage events
    for (let i = 0; i < 3; i++) {
      await service.reportUsage({
        customerId,
        projectId,
        featureSlug,
        usage: 1,
        timestamp: clock.now() + i,
        requestId: `req_usage_flush_${i}`,
        idempotenceKey: `idem_flush_${i}`, // Distinct keys
        metadata: null,
      })
    }

    // Flush
    await service.flush()

    // Analytics called with 3 items
    expect(mockAnalytics.ingestFeaturesUsage).toHaveBeenCalledTimes(1)
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const callArgs = (mockAnalytics.ingestFeaturesUsage as any).mock.calls[0][0]
    expect(callArgs).toHaveLength(3)

    // Storage empty
    const remaining = await mockStorage.getAllUsageRecords()
    expect(remaining.val).toHaveLength(0)
  })
})
