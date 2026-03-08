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

describe("EntitlementService - Pricing", () => {
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
  const featureSlug = "usage-feature"

  // Define a tiered pricing config
  const pricingConfig = {
    usageMode: "tier" as const,
    tierMode: "graduated" as const,
    tiers: [
      {
        firstUnit: 1,
        lastUnit: 10,
        unitPrice: {
          dinero: dinero({ amount: 100, currency: currencies.USD }).toJSON(),
          displayAmount: "1.00",
        },
        flatPrice: {
          dinero: dinero({ amount: 0, currency: currencies.USD }).toJSON(),
          displayAmount: "0",
        },
      },
      {
        firstUnit: 11,
        lastUnit: 20,
        unitPrice: {
          dinero: dinero({ amount: 50, currency: currencies.USD }).toJSON(),
          displayAmount: "0.50",
        },
        flatPrice: {
          dinero: dinero({ amount: 0, currency: currencies.USD }).toJSON(),
          displayAmount: "0",
        },
      },
      {
        firstUnit: 21,
        lastUnit: null,
        unitPrice: {
          dinero: dinero({ amount: 20, currency: currencies.USD }).toJSON(),
          displayAmount: "0.20",
        },
        flatPrice: {
          dinero: dinero({ amount: 0, currency: currencies.USD }).toJSON(),
          displayAmount: "0",
        },
      },
    ],
  }

  const mockEntitlementState = createMockEntitlementState({
    id: "ent_usage",
    customerId,
    projectId,
    featureSlug,
    featureType: "usage",
    limit: 100,
    grants: [
      {
        id: "grant_usage",
        type: "subscription",
        effectiveAt: now - 10000,
        expiresAt: now + 10000,
        limit: 100,
        priority: 10,
        config: pricingConfig,
        featurePlanVersionId: "fpv_idem_1",
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
      },
      customerEntitlements: {
        swr: vi
          .fn()
          .mockImplementation(async (_key, fetcher) => ({ val: await fetcher(), fresh: true })),
        set: vi.fn(),
      },
      negativeEntitlements: {
        get: vi.fn().mockResolvedValue({ val: null }),
        set: vi.fn(),
      },
      accessControlList: {
        get: vi.fn().mockResolvedValue({ val: null }),
        set: vi.fn(),
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
      waitUntil: (p) => p, // Execute immediately for tests
      cache: mockCache,
      metrics: mockMetrics,
    })
  })

  it("should calculate correct cost and rate for tiered usage (Tier 1)", async () => {
    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 5,
      timestamp: clock.now(),
      idempotenceKey: "key_1",
      requestId: "req_1",
      metadata: null,
    })

    expect(result.allowed).toBe(true)
    expect(result.usage).toBe(5)
    expect(result.cost).toBe(5) // 5 units * $1.00
  })

  it("should calculate correct cost and rate for tiered usage (Tier 2 cross-over)", async () => {
    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 15,
      timestamp: clock.now(),
      idempotenceKey: "key_2",
      requestId: "req_2",
      metadata: null,
    })

    expect(result.allowed).toBe(true)
    expect(result.usage).toBe(15)
    // 10 units * $1.00 + 5 units * $0.50 = $10 + $2.5 = $12.5
    expect(result.cost).toBe(12.5)
  })

  it("should calculate correct cost and rate for tiered usage (Tier 3 cross-over)", async () => {
    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 25,
      timestamp: clock.now(),
      idempotenceKey: "key_3",
      requestId: "req_3",
      metadata: null,
    })

    expect(result.allowed).toBe(true)
    expect(result.usage).toBe(25)
    // 10 * $1.00 + 10 * $0.50 + 5 * $0.20 = $10 + $5 + $1 = $16
    expect(result.cost).toBe(16)
  })

  it("should calculate correct cost and rate for simple unit usage", async () => {
    const unitPricingConfig = {
      usageMode: "unit" as const,
      price: {
        dinero: dinero({ amount: 250, currency: currencies.USD }).toJSON(),
        displayAmount: "2.50",
      },
    }

    const unitEntitlementState = createMockEntitlementState({
      id: "ent_unit",
      customerId,
      projectId,
      featureSlug: "unit-feature",
      featureType: "usage",
      limit: 100,
      grants: [
        {
          id: "grant_unit",
          type: "subscription",
          effectiveAt: now - 10000,
          expiresAt: now + 10000,
          limit: 100,
          priority: 10,
          config: unitPricingConfig,
          featurePlanVersionId: "fpv_unit_1",
        },
      ],
    })

    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue(unitEntitlementState)

    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug: "unit-feature",
      usage: 4,
      timestamp: clock.now(),
      idempotenceKey: "key_unit",
      requestId: "req_unit",
      metadata: null,
    })

    expect(result.allowed).toBe(true)
    expect(result.usage).toBe(4)
    expect(result.cost).toBe(10) // 4 * $2.50 = $10
  })
})
