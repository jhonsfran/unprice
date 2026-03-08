import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import * as fc from "fast-check"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { GrantsManager } from "./grants"

describe("GrantsManager", () => {
  let grantsManager: GrantsManager
  let mockDb: Database
  let mockLogger: Logger

  const now = Date.now()
  const customerId = "cust_grants_123"
  const projectId = "proj_grants_123"
  const featureSlug = "merge-test-feature"

  // Base grant object for reuse
  const baseGrant = {
    id: "grant_base",
    projectId,
    subjectType: "customer" as const,
    subjectId: customerId,
    type: "subscription" as const,
    featurePlanVersionId: "fpv_1",
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    deleted: false,
    autoRenew: true,
    priority: 10,
    featurePlanVersion: {
      feature: {
        slug: featureSlug,
      },
      featureType: "usage" as const,
      unitOfMeasure: "units",
      aggregationMethod: "sum" as const,
      config: {
        usageMode: "sum",
      },
      billingConfig: {
        name: "billing",
        billingInterval: "month" as const,
        billingIntervalCount: 1,
        planType: "recurring" as const,
      },
      resetConfig: {
        name: "billing",
        resetInterval: "month" as const,
        resetIntervalCount: 1,
        planType: "recurring" as const,
        resetAnchor: 1,
      },
      metadata: {
        overageStrategy: "none" as const,
      },
    },
    anchor: 1,
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockLogger = {
      set: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger

    mockDb = {
      query: {
        customers: {
          findFirst: vi.fn(),
        },
        grants: {
          findMany: vi.fn(),
        },
        entitlements: {
          findFirst: vi.fn(),
        },
      },
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "ent_new" }]),
          })),
        })),
      })),
    } as unknown as Database

    grantsManager = new GrantsManager({ db: mockDb, logger: mockLogger })
  })

  // Helper to mock DB responses
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  const setupMocks = (grantsList: any[]) => {
    // Mock customer subscription (always found)
    vi.spyOn(mockDb.query.customers, "findFirst").mockResolvedValue({
      subscriptions: [{ phases: [{ planVersion: { plan: { id: "plan_1" }, id: "pv_1" } }] }],
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    } as any)

    // We should only return the list ONCE, or filter by arguments if possible.
    // Or just mock implementation to return empty list for subsequent calls.
    let callCount = 0
    vi.spyOn(mockDb.query.grants, "findMany").mockImplementation(() => {
      if (callCount === 0) {
        callCount++
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        return grantsList as any
      }
      return []
    })

    // Mock existing entitlement (not found -> create new)
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue(undefined)

    // Mock insert to return the object passed to it (simulating DB behavior for test purposes)
    vi.spyOn(mockDb, "insert").mockReturnValue({
      values: vi.fn().mockImplementation((values) => ({
        onConflictDoUpdate: vi.fn().mockImplementation((params) => ({
          returning: vi.fn().mockResolvedValue([
            {
              ...values, // Return the values we just inserted
              ...params.set, // Apply any updates
              id: "ent_new_1",
            },
          ]),
        })),
      })),
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    } as any)
  }

  describe("computeGrantsForCustomer - Merge Rules", () => {
    it("should sum limits for usage features", async () => {
      const grants = [
        {
          ...baseGrant,
          id: "g1",
          limit: 100,
          priority: 10,
          featurePlanVersion: { ...baseGrant.featurePlanVersion, featureType: "usage" as const },
        },
        {
          ...baseGrant,
          id: "g2",
          limit: 50,
          priority: 20,
          featurePlanVersion: { ...baseGrant.featurePlanVersion, featureType: "usage" as const },
        },
      ]

      setupMocks(grants)

      const result = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(1)
      const entitlement = result.val![0]
      expect(entitlement).toBeDefined()
      expect(entitlement!.limit).toBe(150) // 100 + 50
      expect(entitlement!.mergingPolicy).toBe("sum")

      // Verify effectiveAt/expiresAt from min/max of grants
      expect(grants[0]).toBeDefined()
      expect(grants[1]).toBeDefined()
      const minStart = Math.min(grants[0]!.effectiveAt, grants[1]!.effectiveAt)
      const maxEnd = Math.max(grants[0]!.expiresAt, grants[1]!.expiresAt)
      expect(entitlement!.effectiveAt).toBe(minStart)
      expect(entitlement!.expiresAt).toBe(maxEnd)

      // Verify feature slug and type
      expect(entitlement!.featureSlug).toBe(featureSlug)
      expect(entitlement!.featureType).toBe("usage")
      expect(entitlement!.aggregationMethod).toBe("sum")
    })

    it("should take max limit for tier features", async () => {
      const tierFeature = { ...baseGrant.featurePlanVersion, featureType: "tier" as const }
      const grants = [
        {
          ...baseGrant,
          id: "g1",
          limit: 100,
          priority: 10,
          featurePlanVersion: tierFeature,
        },
        {
          ...baseGrant,
          id: "g2",
          limit: 500,
          priority: 20,
          featurePlanVersion: tierFeature,
        },
        {
          ...baseGrant,
          id: "g3",
          limit: 50,
          priority: 5,
          featurePlanVersion: tierFeature,
        },
      ]

      setupMocks(grants)

      const result = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val![0]
      expect(entitlement).toBeDefined()
      expect(entitlement!.limit).toBe(500) // Max of 100, 500, 50
      expect(entitlement!.mergingPolicy).toBe("max")

      // Verify aggregation method
      expect(entitlement!.aggregationMethod).toBe("sum")

      // Verify only the winning grant is kept in the entitlement
      expect(entitlement!.grants).toHaveLength(1)
      expect(entitlement!.grants[0]!.id).toBe("g2") // g2 has limit 500
    })

    it("should replace limits for flat features (highest priority wins)", async () => {
      const flatFeature = { ...baseGrant.featurePlanVersion, featureType: "flat" as const }
      const grants = [
        {
          ...baseGrant,
          id: "g_low",
          limit: 100,
          priority: 10,
          featurePlanVersion: flatFeature,
        },
        {
          ...baseGrant,
          id: "g_high",
          limit: 999,
          priority: 100, // Highest priority
          featurePlanVersion: flatFeature,
        },
      ]

      setupMocks(grants)

      const result = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val![0]
      expect(entitlement).toBeDefined()
      expect(entitlement!.limit).toBe(999)
      expect(entitlement!.mergingPolicy).toBe("replace")

      // Verify only the winning grant is kept in the entitlement
      expect(entitlement!.grants).toHaveLength(1)
      expect(entitlement!.grants[0]!.id).toBe("g_high") // g_high has priority 100

      // Verify reset config is taken from highest priority grant (if any)
      expect(entitlement!.resetConfig).toBeDefined()
      // @ts-ignore
      expect(entitlement!.resetConfig!.name).toBe("billing")
      // @ts-ignore
      expect(entitlement!.resetConfig!.resetAnchor).toBe(1)
    })

    it("should allow overage if ANY grant allows it (sum policy)", async () => {
      const usageFeature = { ...baseGrant.featurePlanVersion, featureType: "usage" as const }
      const grants = [
        {
          ...baseGrant,
          id: "g_strict",
          limit: 100,
          featurePlanVersion: {
            ...usageFeature,
            metadata: { overageStrategy: "none" as const },
          },
        },
        {
          ...baseGrant,
          id: "g_loose",
          limit: 50,
          featurePlanVersion: {
            ...usageFeature,
            metadata: { overageStrategy: "always" as const },
          },
        },
      ]

      setupMocks(grants)

      const result = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val![0]
      expect(entitlement).toBeDefined()
      expect(entitlement!.metadata?.overageStrategy).toBe("always")
    })

    it("should allow overage if ANY grant allows it (max policy)", async () => {
      const tierFeature = { ...baseGrant.featurePlanVersion, featureType: "tier" as const }
      const grants = [
        {
          ...baseGrant,
          id: "g_strict",
          limit: 100,
          featurePlanVersion: {
            ...tierFeature,
            metadata: { overageStrategy: "none" as const },
          },
        },
        {
          ...baseGrant,
          id: "g_loose",
          limit: 50,
          featurePlanVersion: {
            ...tierFeature,
            metadata: { overageStrategy: "always" as const },
          },
        },
      ]

      setupMocks(grants)

      const result = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val![0]
      expect(entitlement).toBeDefined()
      expect(entitlement!.metadata?.overageStrategy).toBe("always")
    })

    it("should require ALL grants to allow overage for min policy", async () => {
      const feature = {
        ...baseGrant.featurePlanVersion,
        featureType: "usage" as const,
        metadata: { overageStrategy: "always" as const },
      }
      const grantsData = [
        {
          id: "g1",
          type: "subscription" as const,
          name: "g1",
          effectiveAt: now,
          expiresAt: now + 1000,
          limit: 100,
          priority: 10,
          featurePlanVersionId: "fpv1",
          featurePlanVersion: {
            ...feature,
            metadata: { overageStrategy: "always" as const },
          },
          subjectId: customerId,
          subjectType: "customer" as const,
          projectId,
          anchor: 1,
        },
        {
          id: "g2",
          type: "subscription" as const,
          name: "g2",
          effectiveAt: now,
          expiresAt: now + 1000,
          limit: 50,
          priority: 20,
          featurePlanVersionId: "fpv1",
          featurePlanVersion: {
            ...feature,
            metadata: { overageStrategy: "none" as const },
          },
          subjectId: customerId,
          subjectType: "customer" as const,
          projectId,
          anchor: 1,
        },
      ]

      const merged = grantsManager.mergeGrants({
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        grants: grantsData as any,
        policy: "min",
      })

      expect(merged.limit).toBe(50)
    })

    it("Property-based test: Highest priority grant always wins in 'replace' policy", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              id: fc.uuid(),
              priority: fc.integer({ min: 0, max: 1000 }),
              limit: fc.integer({ min: 1, max: 10000 }),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (grantsSnapshotData) => {
            const sorted = [...grantsSnapshotData].sort((a, b) => b.priority - a.priority)
            const highestPriority = sorted[0]!

            const merged = grantsManager.mergeGrants({
              // biome-ignore lint/suspicious/noExplicitAny: <explanation>
              grants: grantsSnapshotData as any,
              policy: "replace",
            })

            expect(merged.limit).toBe(highestPriority.limit)
          }
        )
      )
    })
  })

  describe("renewGrantsForCustomer", () => {
    it("should renew auto-renewing grants that are not trial or subscription", async () => {
      const grantToRenew = {
        ...baseGrant,
        id: "g_addon",
        type: "addon" as const,
        autoRenew: true,
        effectiveAt: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago
        expiresAt: now + 1000, // Grant is still active
      }

      setupMocks([grantToRenew])

      // Mock createGrant (insert)
      vi.spyOn(mockDb, "insert").mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...grantToRenew, id: "g_addon_renewed" }]),
          }),
        }),
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      } as any)

      const result = await grantsManager.renewGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(1)
      expect(result.val?.[0]?.id).toBe("g_addon_renewed")
    })

    it("should not renew trial or subscription grants", async () => {
      const grants = [
        { ...baseGrant, id: "g_sub", type: "subscription" as const, autoRenew: true },
        { ...baseGrant, id: "g_trial", type: "trial" as const, autoRenew: true },
      ]

      setupMocks(grants)

      const result = await grantsManager.renewGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(0)
    })
  })
})
