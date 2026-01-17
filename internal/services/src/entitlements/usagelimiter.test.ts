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

describe("EntitlementService - verify", () => {
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
  const featureSlug = "test-feature"

  const mockEntitlementState = createMockEntitlementState({
    id: "ent_123",
    customerId,
    projectId,
    featureSlug,
    limit: 100,
    meter: {
      usage: "10",
      snapshotUsage: "10",
      lastReconciledId: "rec_initial",
      lastUpdated: now,
      lastCycleStart: now - 10000,
    },
    grants: [
      {
        id: "grant_1",
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

    // Mock Logger
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    } as unknown as Logger

    // Mock Analytics
    mockAnalytics = {
      ingestFeaturesVerification: vi.fn().mockResolvedValue({ successful_rows: 1 }),
      getFeaturesUsageCursor: vi.fn().mockImplementation((params) => {
        let usage = 0
        if (params.customerId === "cust_123" || params.customerId === "cust_usage_123") {
          usage = 10
        }
        if (params.customerId === "cust_overlimit") {
          usage = 101
        }
        return Promise.resolve(Ok({ usage, lastRecordId: "rec_initial" }))
      }),
    } as unknown as Analytics

    // Mock Database
    mockDb = {
      query: {
        entitlements: {
          findFirst: vi.fn().mockResolvedValue(mockEntitlementState),
        },
        customers: {
          findFirst: vi.fn().mockResolvedValue({ subscriptions: [] }),
        },
        grants: {
          findMany: vi.fn().mockResolvedValue([]),
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

    // Mock Cache
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

    // Mock Metrics
    mockMetrics = {} as unknown as Metrics

    // Initialize Memory Storage
    mockStorage = new MemoryEntitlementStorageProvider({
      logger: mockLogger,
      analytics: mockAnalytics,
    })
    await mockStorage.initialize()

    // Initialize Service
    service = new EntitlementService({
      db: mockDb,
      storage: mockStorage,
      logger: mockLogger,
      analytics: mockAnalytics,
      waitUntil: vi.fn(),
      cache: mockCache,
      metrics: mockMetrics,
    })
  })

  it("should verify entitlement successfully when loaded from DB (cache miss)", async () => {
    // Setup DB mock to return the entitlement
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...mockEntitlementState,
      createdAtM: clock.now(),
      updatedAtM: clock.now(),
    })

    const result = await service.verify({
      customerId,
      projectId,
      featureSlug,
      timestamp: clock.now(),
      requestId: "req_1",
      metadata: null,
      performanceStart: performance.now(),
    })

    // Assertions
    expect(result.allowed).toBe(true)
    expect(result.usage).toBe(10)
    expect(result.deniedReason).toBeUndefined()

    // Check if it tried to load from DB
    expect(mockDb.query.entitlements.findFirst).toHaveBeenCalledTimes(1)

    // Check if it stored in memory storage
    const stored = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(stored.val).toBeDefined()
    expect(stored.val?.id).toBe(mockEntitlementState.id)

    // Check if verification was recorded in storage
    const verifications = await mockStorage.getAllVerifications()

    expect(verifications.val).toHaveLength(1)
    expect(verifications.val?.[0]).toMatchObject({
      customerId,
      projectId,
      featureSlug,
      allowed: 1,
    })
  })

  it("should verify entitlement from memory storage (cache hit)", async () => {
    // Pre-populate storage
    await mockStorage.set({ state: mockEntitlementState })

    const result = await service.verify({
      customerId,
      projectId,
      featureSlug,
      timestamp: clock.now(),
      requestId: "req_2",
      metadata: null,
      performanceStart: performance.now(),
    })

    expect(result.allowed).toBe(true)

    // DB should NOT be called
    expect(mockDb.query.entitlements.findFirst).not.toHaveBeenCalled()
  })

  it("should deny access when usage exceeds limit", async () => {
    const exceededState = createMockEntitlementState(
      {
        customerId: "cust_overlimit",
        projectId,
        featureSlug,
        meter: {
          usage: "101", // usage > limit
          snapshotUsage: "101",
          lastReconciledId: "rec_initial",
          lastUpdated: now,
          lastCycleStart: now - 10000,
        },
        createdAtM: clock.now(),
        updatedAtM: clock.now(),
        grants: [
          {
            id: "grant_1",
            type: "subscription",
            priority: 10,
            limit: 100,
            effectiveAt: clock.now() - 10000,
            expiresAt: clock.now() + 10000,
          },
        ],
      },
      clock.now()
    )

    // Setup DB mock
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue(exceededState)

    const result = await service.verify({
      customerId: "cust_overlimit",
      projectId,
      featureSlug,
      timestamp: clock.now(),
      requestId: "req_3",
      metadata: null,
      performanceStart: performance.now(),
    })

    expect(result.allowed).toBe(false)
    expect(result.deniedReason).toBe("LIMIT_EXCEEDED")

    // Check if verification was recorded as denied
    const verifications = await mockStorage.getAllVerifications()
    expect(verifications.val).toHaveLength(1)
    expect(verifications.val?.[0]).toMatchObject({
      allowed: 0,
      deniedReason: "LIMIT_EXCEEDED",
    })
  })

  it("should return not found when entitlement does not exist", async () => {
    // DB returns null
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue(undefined)

    const result = await service.verify({
      customerId,
      projectId,
      featureSlug: "non-existent",
      timestamp: clock.now(),
      requestId: "req_4",
      metadata: null,
      performanceStart: performance.now(),
    })

    expect(result.allowed).toBe(false)
    expect(result.deniedReason).toBe("ENTITLEMENT_NOT_FOUND")

    // Check if verification was recorded as denied
    const verifications = await mockStorage.getAllVerifications()
    expect(verifications.val).toHaveLength(1)
    expect(verifications.val?.[0]).toMatchObject({
      featureSlug: "non-existent",
      allowed: 0,
      deniedReason: "ENTITLEMENT_NOT_FOUND",
    })
  })
})

describe("EntitlementService - reportUsage", () => {
  let service: EntitlementService
  let mockDb: Database
  let mockStorage: MemoryEntitlementStorageProvider
  let mockLogger: Logger
  let mockAnalytics: Analytics
  let mockCache: Cache
  let mockMetrics: Metrics

  const now = Date.now()
  const clock = createClock(now)
  const customerId = "cust_usage_123"
  const projectId = "proj_usage_123"
  const featureSlug = "usage-feature"

  const mockEntitlementState = createMockEntitlementState({
    id: "ent_usage_123",
    customerId,
    projectId,
    featureSlug,
    limit: 100,
    meter: {
      usage: "10",
      snapshotUsage: "10",
      lastReconciledId: "rec_initial",
      lastUpdated: now,
      lastCycleStart: now - 10000,
    },
    grants: [
      {
        id: "grant_usage_1",
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
      getFeaturesUsageCursor: vi.fn().mockImplementation((params) => {
        let usage = 0
        if (params.customerId === "cust_123" || params.customerId === "cust_usage_123") {
          usage = 10
        }
        if (params.customerId === "cust_overlimit") {
          usage = 101
        }
        return Promise.resolve(Ok({ usage, lastRecordId: "rec_initial" }))
      }),
    } as unknown as Analytics

    // Mock Database
    mockDb = {
      query: {
        entitlements: {
          findFirst: vi.fn(),
        },
        customers: {
          findFirst: vi.fn().mockResolvedValue({ subscriptions: [] }),
        },
        grants: {
          findMany: vi.fn().mockResolvedValue([]),
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
      negativeEntitlements: {
        get: vi.fn().mockResolvedValue({ val: null }),
        set: vi.fn(),
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
      waitUntil: vi.fn((promise) => promise), // Execute immediately for testing
      cache: mockCache,
      metrics: mockMetrics,
    })

    // biome-ignore lint/suspicious/noExplicitAny: on first call the entitlement is not found in the cache so we need to compute it
    const computeSpy = vi.spyOn((service as any).grantsManager, "computeGrantsForCustomer")
    computeSpy.mockResolvedValue(Ok([mockEntitlementState]))
  })

  it("should consume usage successfully and update state", async () => {
    // Setup DB mock
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    ;(mockDb.query.entitlements.findFirst as any).mockResolvedValue({
      ...mockEntitlementState,
      createdAtM: clock.now(),
      updatedAtM: clock.now(),
    })

    const usageAmount = 5
    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: usageAmount,
      timestamp: clock.now(),
      requestId: "req_usage_1",
      idempotenceKey: "idem_1",
      metadata: null,
    })

    expect(result.allowed).toBe(true)
    expect(result.usage).toBe(15) // 10 (initial) + 5
    expect(result.deniedReason).toBeUndefined()

    // Check storage update
    const stored = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(stored.val?.meter.usage).toBe("15")

    // Check usage record
    const usageRecords = await mockStorage.getAllUsageRecords()
    expect(usageRecords.val).toHaveLength(1)
    expect(usageRecords.val?.[0]).toMatchObject({
      customerId,
      projectId,
      featureSlug,
      usage: usageAmount,
    })
  })

  it("should deny usage when limit is exceeded", async () => {
    const usageAmount = 91 // 10 + 91 = 101 > 100
    // Setup DB mock
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    ;(mockDb.query.entitlements.findFirst as any).mockResolvedValue({
      ...mockEntitlementState,
      createdAtM: clock.now(),
      updatedAtM: clock.now(),
    })

    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: usageAmount,
      timestamp: clock.now(),
      requestId: "req_usage_2",
      idempotenceKey: "idem_2",
      metadata: null,
    })

    expect(result.allowed).toBe(false)
    expect(result.deniedReason).toBe("LIMIT_EXCEEDED")

    // Storage should NOT be updated with new usage
    const stored = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(stored.val?.meter.usage).toBe("10")

    // No usage record should be inserted for denied usage
    const usageRecords = await mockStorage.getAllUsageRecords()
    expect(usageRecords.val).toHaveLength(0)
  })

  it("should handle random usage amounts correctly", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    ;(mockDb.query.entitlements.findFirst as any).mockResolvedValue({
      ...mockEntitlementState,
      createdAtM: clock.now(),
      updatedAtM: clock.now(),
    })

    // Pre-populate storage so we can accumulate
    await mockStorage.set({ state: mockEntitlementState })

    let currentUsage = 10 // Start with 10

    // Random valid usages
    for (let i = 0; i < 5; i++) {
      const usage = Math.floor(Math.random() * 5) + 1 // 1 to 5

      const result = await service.reportUsage({
        customerId,
        projectId,
        featureSlug,
        usage,
        timestamp: clock.now(),
        requestId: `req_rand_${i}`,
        idempotenceKey: `idem_rand_${i}`,
        metadata: null,
      })

      if (currentUsage + usage <= 100) {
        expect(result.allowed).toBe(true)
        currentUsage += usage
        expect(result.usage).toBe(currentUsage)
      } else {
        expect(result.allowed).toBe(false)
      }
    }
  })
})
