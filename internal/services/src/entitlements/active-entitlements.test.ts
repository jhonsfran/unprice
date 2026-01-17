import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { EntitlementState, MinimalEntitlement } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { MemoryEntitlementStorageProvider } from "./memory-provider"
import { EntitlementService } from "./service"

describe("EntitlementService - Active Entitlements & Cycle Changes", () => {
  let service: EntitlementService
  let mockDb: Database
  let mockStorage: MemoryEntitlementStorageProvider
  let mockLogger: Logger
  let mockAnalytics: Analytics
  let mockCache: Cache
  let mockMetrics: Metrics

  const customerId = "cust_active_123"
  const projectId = "proj_active_123"
  const featureSlug = "feature-a"
  const featureSlugB = "feature-b"
  const now = Date.now()

  const mockEntitlementState: EntitlementState = {
    id: "ent_1",
    customerId,
    projectId,
    featureSlug,
    featureType: "usage",
    limit: 100,
    aggregationMethod: "sum",
    mergingPolicy: "sum",
    grants: [],
    version: "v1",
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    nextRevalidateAt: now + 3600000,
    computedAt: now,
    resetConfig: null,
    metadata: {
      realtime: false,
      notifyUsageThreshold: 95,
      overageStrategy: "none",
      blockCustomer: false,
      hidden: false,
    },
    createdAtM: now,
    updatedAtM: now,
    meter: {
      usage: "0",
      lastReconciledId: "",
      snapshotUsage: "0",
      lastUpdated: now,
      lastCycleStart: now - 10000,
    },
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
      getFeaturesUsageCursor: vi.fn().mockResolvedValue(
        Ok({
          usage: 0,
          lastRecordId: "rec_initial",
        })
      ),
    } as unknown as Analytics

    mockDb = {
      query: {
        entitlements: {
          findFirst: vi.fn(),
          findMany: vi.fn(),
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
          return { val, err: undefined }
        }),
        set: vi.fn(),
        get: vi.fn(),
        remove: vi.fn(),
      },
      customerEntitlements: {
        swr: vi.fn().mockImplementation(async (_key, fetcher) => {
          const val = await fetcher()
          return { val, err: undefined }
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

    mockStorage = new MemoryEntitlementStorageProvider({ logger: mockLogger })
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

  describe("getActiveEntitlements", () => {
    it("should handle cold start (loading from DB via cache SWR)", async () => {
      // 1. Mock DB query to return minimal entitlement
      const minimalEntitlement: MinimalEntitlement = {
        id: mockEntitlementState.id,
        featureSlug: mockEntitlementState.featureSlug,
        effectiveAt: mockEntitlementState.effectiveAt,
        expiresAt: mockEntitlementState.expiresAt,
      }
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      ;(mockDb.query.entitlements.findMany as any).mockResolvedValue([minimalEntitlement])

      // 2. Call getActiveEntitlements
      const result = await service.getActiveEntitlements({
        customerId,
        projectId,
        opts: {
          now,
        },
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(1)
      expect(result.val![0]).toEqual(minimalEntitlement)

      // 3. Verify DB was queried
      expect(mockDb.query.entitlements.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.any(Function),
        })
      )
    })

    it("should return multiple entitlements from DB", async () => {
      // 1. Mock DB query to return multiple minimal entitlements
      const minimalA: MinimalEntitlement = {
        id: "ent_a",
        featureSlug: "feature-a",
        effectiveAt: now - 10000,
        expiresAt: now + 10000,
      }
      const minimalB: MinimalEntitlement = {
        id: "ent_b",
        featureSlug: featureSlugB,
        effectiveAt: now - 5000,
        expiresAt: null,
      }

      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      ;(mockDb.query.entitlements.findMany as any).mockResolvedValue([minimalA, minimalB])

      // 2. Call
      const result = await service.getActiveEntitlements({
        customerId,
        projectId,
        opts: { now },
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(2)
      expect(result.val).toEqual(expect.arrayContaining([minimalA, minimalB]))
    })
  })

  describe("getStateWithRevalidation (Cycle Change Edge Case)", () => {
    it("should recompute and initialize when expired in storage", async () => {
      // 1. Setup expired entitlement in storage
      const expiredState: EntitlementState = {
        ...mockEntitlementState,
        expiresAt: now - 1000,
      }
      await mockStorage.set({ state: expiredState })

      // 2. Mock grantsManager.computeGrantsForCustomer to return "renewed" entitlement
      const renewedEntitlement = {
        id: "ent_renewed",
        customerId,
        projectId,
        featureSlug,
        featureType: "usage" as const,
        limit: 100,
        allowOverage: false,
        aggregationMethod: "sum" as const,
        mergingPolicy: "sum" as const,
        grants: [
          {
            id: "grant_1",
            priority: 10,
            effectiveAt: now - 10000,
            expiresAt: now + 10000,
          },
        ],
        version: "v2",
        effectiveAt: now - 5000,
        expiresAt: now + 5000,
        nextRevalidateAt: now + 3600000,
        computedAt: now,
        resetConfig: null,
        metadata: {},
        createdAtM: now,
        updatedAtM: now,
      }
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      const computeSpy = vi.spyOn((service as any).grantsManager, "computeGrantsForCustomer")
      computeSpy.mockResolvedValue(Ok([renewedEntitlement]))

      // 3. Mock analytics for initializeUsageMeter
      vi.mocked(mockAnalytics.getFeaturesUsageCursor).mockResolvedValue(
        Ok({
          usage: 50,
          lastRecordId: "rec_new",
          featureSlug: featureSlug,
        })
      )

      // 4. Trigger revalidation via reportUsage
      const reportResult = await service.reportUsage({
        customerId,
        projectId,
        featureSlug,
        usage: 1,
        timestamp: now,
        requestId: "req_1",
        idempotenceKey: "key_1",
        metadata: null,
      })

      expect(reportResult.allowed).toBe(true)
      expect(reportResult.usage).toBe(51)

      // 5. Verify storage was updated with initialized meter
      const stored = await mockStorage.get({ customerId, projectId, featureSlug })
      expect(stored.val).toBeDefined()
      expect(stored.val?.id).toBe("ent_renewed")
      expect(stored.val?.meter.usage).toBe("51")
      expect(stored.val?.meter.lastReconciledId).toBe("rec_new")
    })
  })
})
