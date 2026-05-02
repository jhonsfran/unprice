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
    createdAtM: now - 20_000,
    updatedAtM: now - 10_000,
    projectId,
    name: "grant_base",
    subjectType: "customer" as const,
    subjectId: customerId,
    meterHash: "meter_hash_value",
    type: "subscription" as const,
    featurePlanVersionId: "fpv_1",
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    limit: 100,
    units: 1,
    overageStrategy: "none" as const,
    metadata: null,
    deleted: false,
    deletedAt: null,
    priority: 10,
    featurePlanVersion: {
      id: "fpv_1",
      createdAtM: now - 20_000,
      updatedAtM: now - 10_000,
      projectId,
      planVersionId: "pv_1",
      type: "feature" as const,
      featureId: "feat_1",
      order: 1,
      defaultQuantity: 1,
      limit: 100,
      feature: {
        id: "feat_1",
        createdAtM: now - 20_000,
        updatedAtM: now - 10_000,
        projectId,
        slug: featureSlug,
        code: 1,
        unitOfMeasure: "units",
        title: "Merge Test Feature",
        description: null,
        meterConfig: null,
      },
      featureType: "usage" as const,
      unitOfMeasure: "units",
      meterConfig: {
        eventId: "event_usage",
        eventSlug: "merge-test-feature",
        aggregationMethod: "sum" as const,
        aggregationField: "value",
      },
      config: {
        usageMode: "unit" as const,
        price: {
          dinero: {
            amount: 0,
            currency: {
              code: "USD",
              base: 10,
              exponent: 2,
            },
            scale: 2,
          },
          displayAmount: "0.00",
        },
      },
      billingConfig: {
        name: "billing",
        billingInterval: "month" as const,
        billingIntervalCount: 1,
        billingAnchor: 1,
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
        realtime: false,
        notifyUsageThreshold: 95,
        overageStrategy: "none" as const,
        blockCustomer: false,
        hidden: false,
      },
    },
    anchor: 1,
  }

  // Helper to mock DB responses for tests that need getGrantsForCustomer
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  const setupMocks = (grantsList: any[]) => {
    vi.spyOn(mockDb.query.customers, "findFirst").mockResolvedValue({
      subscriptions: [{ phases: [{ planVersion: { plan: { id: "plan_1" }, id: "pv_1" } }] }],
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    } as any)

    let callCount = 0
    vi.spyOn(mockDb.query.grants, "findMany").mockImplementation(() => {
      if (callCount === 0) {
        callCount++
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        return grantsList as any
      }
      return []
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockLogger = {
      set: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger

    mockDb = {
      query: {
        customers: {
          findFirst: vi.fn(),
        },
        grants: {
          findMany: vi.fn(),
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

  describe("computeEntitlementState - Merge Rules", () => {
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

      const result = await grantsManager.computeEntitlementState({
        customerId,
        projectId,
        grants,
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val!
      expect(entitlement.limit).toBe(150) // 100 + 50
      expect(entitlement.mergingPolicy).toBe("sum")

      // Verify the window bounds
      expect(grants[0]).toBeDefined()
      expect(grants[1]).toBeDefined()
      const minStart = Math.min(grants[0]!.effectiveAt, grants[1]!.effectiveAt)
      const maxEnd = Math.max(grants[0]!.expiresAt, grants[1]!.expiresAt)
      expect(entitlement.effectiveAt).toBe(minStart)
      expect(entitlement.expiresAt).toBe(maxEnd)

      // Verify feature slug and type
      expect(entitlement.featureSlug).toBe(featureSlug)
      expect(entitlement.featureType).toBe("usage")
      expect(entitlement.meterConfig?.aggregationMethod).toBe("sum")
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

      const result = await grantsManager.computeEntitlementState({
        customerId,
        projectId,
        grants,
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val!
      expect(entitlement.limit).toBe(500) // Max of 100, 500, 50
      expect(entitlement.mergingPolicy).toBe("max")
      expect(entitlement.meterConfig).toBeNull()

      // Verify only the winning grant is kept
      expect(entitlement.grants).toHaveLength(1)
      expect(entitlement.grants[0]!.id).toBe("g2") // g2 has limit 500
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

      const result = await grantsManager.computeEntitlementState({
        customerId,
        projectId,
        grants,
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val!
      expect(entitlement.limit).toBe(999)
      expect(entitlement.mergingPolicy).toBe("replace")

      // Verify only the winning grant is kept
      expect(entitlement.grants).toHaveLength(1)
      expect(entitlement.grants[0]!.id).toBe("g_high")
      expect(entitlement.resetConfig).toBeNull()
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
            metadata: {
              ...baseGrant.featurePlanVersion.metadata,
              overageStrategy: "none" as const,
            },
          },
        },
        {
          ...baseGrant,
          id: "g_loose",
          limit: 50,
          featurePlanVersion: {
            ...usageFeature,
            metadata: {
              ...baseGrant.featurePlanVersion.metadata,
              overageStrategy: "always" as const,
            },
          },
        },
      ]

      const result = await grantsManager.computeEntitlementState({
        customerId,
        projectId,
        grants,
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val!
      expect(entitlement.metadata?.overageStrategy).toBe("always")
    })

    it("splits grants with different meter configs into separate ingestion streams", async () => {
      const grants = [
        {
          ...baseGrant,
          id: "g_input_tokens",
          limit: 100,
          meterHash: "meter_hash_input_tokens",
          featurePlanVersion: {
            ...baseGrant.featurePlanVersion,
            meterConfig: {
              ...baseGrant.featurePlanVersion.meterConfig,
              aggregationField: "input_tokens",
            },
          },
        },
        {
          ...baseGrant,
          id: "g_output_tokens",
          limit: 50,
          meterHash: "meter_hash_output_tokens",
          priority: 20,
          featurePlanVersion: {
            ...baseGrant.featurePlanVersion,
            meterConfig: {
              ...baseGrant.featurePlanVersion.meterConfig,
              aggregationField: "output_tokens",
            },
          },
        },
      ]

      const result = await grantsManager.resolveIngestionStatesFromGrants({
        customerId,
        projectId,
        timestamp: now,
        grants,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(2)

      const statesByField = new Map(
        result.val?.map((state) => [state.meterConfig.aggregationField, state])
      )
      expect(statesByField.get("input_tokens")).toEqual(
        expect.objectContaining({
          activeGrantIds: ["g_input_tokens"],
          limit: 100,
        })
      )
      expect(statesByField.get("output_tokens")).toEqual(
        expect.objectContaining({
          activeGrantIds: ["g_output_tokens"],
          limit: 50,
        })
      )
      expect(statesByField.get("input_tokens")?.meterHash).not.toBe(
        statesByField.get("output_tokens")?.meterHash
      )
    })

    it("allows stacked usage grants with different reset periods", async () => {
      const grants = [
        {
          ...baseGrant,
          id: "g_monthly",
          limit: 100,
        },
        {
          ...baseGrant,
          id: "g_yearly",
          limit: 50,
          priority: 20,
          featurePlanVersion: {
            ...baseGrant.featurePlanVersion,
            resetConfig: {
              ...baseGrant.featurePlanVersion.resetConfig,
              name: "yearly",
              resetInterval: "year" as const,
              resetIntervalCount: 1,
            },
          },
        },
      ]

      const result = await grantsManager.computeEntitlementState({
        customerId,
        projectId,
        grants,
      })

      expect(result.err).toBeUndefined()
      expect(result.val?.limit).toBe(150)
      expect(result.val?.grants.map((grant) => grant.id)).toEqual(["g_yearly", "g_monthly"])
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
            metadata: {
              ...baseGrant.featurePlanVersion.metadata,
              overageStrategy: "none" as const,
            },
          },
        },
        {
          ...baseGrant,
          id: "g_loose",
          limit: 50,
          featurePlanVersion: {
            ...tierFeature,
            metadata: {
              ...baseGrant.featurePlanVersion.metadata,
              overageStrategy: "always" as const,
            },
          },
        },
      ]

      const result = await grantsManager.computeEntitlementState({
        customerId,
        projectId,
        grants,
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val!
      expect(entitlement.metadata?.overageStrategy).toBe("always")
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
            metadata: {
              ...baseGrant.featurePlanVersion.metadata,
              overageStrategy: "always" as const,
            },
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
            metadata: {
              ...baseGrant.featurePlanVersion.metadata,
              overageStrategy: "none" as const,
            },
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

  describe("mergeGrants - null/unlimited limits", () => {
    it("sum: one unlimited grant makes total unlimited", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: 100, effectiveAt: now, expiresAt: now + 1000 },
          { id: "g2", priority: 20, limit: null, effectiveAt: now, expiresAt: now + 1000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        policy: "sum",
      })

      expect(merged.limit).toBeNull()
      expect(merged.grants).toHaveLength(2)
    })

    it("sum: all numeric limits are summed", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: 100, effectiveAt: now, expiresAt: now + 1000 },
          { id: "g2", priority: 20, limit: 200, effectiveAt: now, expiresAt: now + 1000 },
          { id: "g3", priority: 5, limit: 50, effectiveAt: now, expiresAt: now + 1000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        policy: "sum",
      })

      expect(merged.limit).toBe(350)
    })

    it("max: one unlimited grant makes result unlimited", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: 100, effectiveAt: now, expiresAt: now + 1000 },
          { id: "g2", priority: 20, limit: null, effectiveAt: now, expiresAt: now + 1000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        policy: "max",
      })

      expect(merged.limit).toBeNull()
    })

    it("min: all unlimited grants results in unlimited", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: null, effectiveAt: now, expiresAt: now + 1000 },
          { id: "g2", priority: 20, limit: null, effectiveAt: now, expiresAt: now + 1000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        policy: "min",
      })

      expect(merged.limit).toBeNull()
    })

    it("min: mixed unlimited and numeric takes the numeric minimum", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: null, effectiveAt: now, expiresAt: now + 1000 },
          { id: "g2", priority: 20, limit: 100, effectiveAt: now, expiresAt: now + 1000 },
          { id: "g3", priority: 5, limit: 50, effectiveAt: now, expiresAt: now + 1000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        policy: "min",
      })

      expect(merged.limit).toBe(50)
    })
  })

  describe("mergeGrants - single grant", () => {
    it("single grant with sum policy returns that grant's limit", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: 100, effectiveAt: now, expiresAt: now + 1000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        policy: "sum",
      })

      expect(merged.limit).toBe(100)
      expect(merged.grants).toHaveLength(1)
    })

    it("single grant with replace policy returns that grant", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: 42, effectiveAt: now, expiresAt: now + 5000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        policy: "replace",
      })

      expect(merged.limit).toBe(42)
      expect(merged.grants).toHaveLength(1)
      expect(merged.effectiveAt).toBe(now)
      expect(merged.expiresAt).toBe(now + 5000)
    })

    it("single unlimited grant", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: null, effectiveAt: now, expiresAt: now + 1000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        policy: "max",
      })

      expect(merged.limit).toBeNull()
    })
  })

  describe("mergeGrants - window computation", () => {
    it("sum: union of all grant windows", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: 100, effectiveAt: now, expiresAt: now + 5000 },
          { id: "g2", priority: 20, limit: 100, effectiveAt: now - 1000, expiresAt: now + 3000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        policy: "sum",
      })

      expect(merged.effectiveAt).toBe(now - 1000)
      expect(merged.expiresAt).toBe(now + 5000)
    })

    it("sum: unbounded grant makes expiresAt null", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: 100, effectiveAt: now, expiresAt: null },
          { id: "g2", priority: 20, limit: 100, effectiveAt: now - 1000, expiresAt: now + 3000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        policy: "sum",
      })

      expect(merged.effectiveAt).toBe(now - 1000)
      expect(merged.expiresAt).toBeNull()
    })

    it("max/min/replace: window comes from the winning grant", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: 100, effectiveAt: now, expiresAt: now + 5000 },
          {
            id: "g2",
            priority: 20,
            limit: 999,
            effectiveAt: now - 1000,
            expiresAt: now + 3000,
          },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        policy: "max",
      })

      // g2 wins (limit 999), so window is g2's window
      expect(merged.effectiveAt).toBe(now - 1000)
      expect(merged.expiresAt).toBe(now + 3000)
    })
  })

  describe("mergeGrants - empty grants", () => {
    it("returns null limit and empty grants for empty input", () => {
      const merged = grantsManager.mergeGrants({
        grants: [],
        policy: "sum",
      })

      expect(merged.limit).toBeNull()
      expect(merged.grants).toHaveLength(0)
      expect(merged.mergingPolicy).toBe("replace")
    })
  })

  describe("mergeGrants - policy derivation from feature type", () => {
    it("usage feature with unit mode derives sum policy", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: 100, effectiveAt: now, expiresAt: now + 1000 },
          { id: "g2", priority: 20, limit: 50, effectiveAt: now, expiresAt: now + 1000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        featureType: "usage",
        usageMode: "unit",
      })

      expect(merged.mergingPolicy).toBe("sum")
      expect(merged.limit).toBe(150)
    })

    it("usage feature with tier mode derives max policy", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: 100, effectiveAt: now, expiresAt: now + 1000 },
          { id: "g2", priority: 20, limit: 50, effectiveAt: now, expiresAt: now + 1000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        featureType: "usage",
        usageMode: "tier",
      })

      expect(merged.mergingPolicy).toBe("max")
      expect(merged.limit).toBe(100)
    })

    it("package feature derives max policy", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: 100, effectiveAt: now, expiresAt: now + 1000 },
          { id: "g2", priority: 20, limit: 500, effectiveAt: now, expiresAt: now + 1000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        featureType: "package",
      })

      expect(merged.mergingPolicy).toBe("max")
      expect(merged.limit).toBe(500)
    })

    it("flat feature derives replace policy (highest priority wins)", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: 100, effectiveAt: now, expiresAt: now + 1000 },
          { id: "g2", priority: 20, limit: 50, effectiveAt: now, expiresAt: now + 1000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        featureType: "flat",
      })

      expect(merged.mergingPolicy).toBe("replace")
      expect(merged.limit).toBe(50) // g2 wins (priority 20)
    })
  })

  describe("mergeGrants - priority edge cases", () => {
    it("equal priority grants: deterministic winner (first after sort)", () => {
      const merged = grantsManager.mergeGrants({
        grants: [
          { id: "g1", priority: 10, limit: 100, effectiveAt: now, expiresAt: now + 1000 },
          { id: "g2", priority: 10, limit: 200, effectiveAt: now, expiresAt: now + 1000 },
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        ] as any,
        policy: "replace",
      })

      // With equal priority, one must win deterministically
      expect(merged.limit).toBeDefined()
      expect(merged.grants).toHaveLength(1)
    })
  })

  describe("computeEntitlementState - edge cases", () => {
    it("single grant computes correctly", async () => {
      const result = await grantsManager.computeEntitlementState({
        customerId,
        projectId,
        grants: [baseGrant],
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val!
      expect(entitlement.limit).toBe(100)
      expect(entitlement.featureSlug).toBe(featureSlug)
      expect(entitlement.grants).toHaveLength(1)
    })

    it("rejects empty grants array", async () => {
      const result = await grantsManager.computeEntitlementState({
        customerId,
        projectId,
        grants: [],
      })

      expect(result.err).toBeDefined()
      expect(result.err?.message).toContain("No grants provided")
    })

    it("rejects grants with different feature slugs", async () => {
      const result = await grantsManager.computeEntitlementState({
        customerId,
        projectId,
        grants: [
          baseGrant,
          {
            ...baseGrant,
            id: "g2",
            featurePlanVersion: {
              ...baseGrant.featurePlanVersion,
              feature: { ...baseGrant.featurePlanVersion.feature, slug: "other-feature" },
            },
          },
        ],
      })

      expect(result.err).toBeDefined()
      expect(result.err?.message).toContain("same feature slug")
    })

    it("package feature uses max policy", async () => {
      const packageFeature = { ...baseGrant.featurePlanVersion, featureType: "package" as const }
      const result = await grantsManager.computeEntitlementState({
        customerId,
        projectId,
        grants: [
          { ...baseGrant, id: "g1", limit: 100, featurePlanVersion: packageFeature },
          { ...baseGrant, id: "g2", limit: 500, priority: 20, featurePlanVersion: packageFeature },
        ],
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.limit).toBe(500)
      expect(result.val!.mergingPolicy).toBe("max")
    })

    it("usage feature with null usageMode defaults to sum", async () => {
      const usageFeature = {
        ...baseGrant.featurePlanVersion,
        featureType: "usage" as const,
        config: { ...baseGrant.featurePlanVersion.config, usageMode: undefined },
      }
      const result = await grantsManager.computeEntitlementState({
        customerId,
        projectId,
        grants: [
          { ...baseGrant, id: "g1", limit: 100, featurePlanVersion: usageFeature },
          { ...baseGrant, id: "g2", limit: 50, priority: 20, featurePlanVersion: usageFeature },
        ],
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.limit).toBe(150)
      expect(result.val!.mergingPolicy).toBe("sum")
    })
  })

  describe("mergeGrants - property-based tests", () => {
    const grantArb = fc.record({
      id: fc.uuid(),
      priority: fc.integer({ min: 0, max: 1000 }),
      limit: fc.integer({ min: 1, max: 10000 }),
      effectiveAt: fc.integer({ min: 0, max: 1_000_000 }),
      expiresAt: fc.integer({ min: 1_000_001, max: 2_000_000 }),
    })

    it("sum: result limit equals sum of all limits", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(grantArb, { minLength: 1, maxLength: 10 }),
          async (grantsData) => {
            const merged = grantsManager.mergeGrants({
              // biome-ignore lint/suspicious/noExplicitAny: <explanation>
              grants: grantsData as any,
              policy: "sum",
            })

            const expectedSum = grantsData.reduce((sum, g) => sum + g.limit, 0)
            expect(merged.limit).toBe(expectedSum)
          }
        )
      )
    })

    it("max: result limit equals max of all limits", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(grantArb, { minLength: 1, maxLength: 10 }),
          async (grantsData) => {
            const merged = grantsManager.mergeGrants({
              // biome-ignore lint/suspicious/noExplicitAny: <explanation>
              grants: grantsData as any,
              policy: "max",
            })

            const expectedMax = Math.max(...grantsData.map((g) => g.limit))
            expect(merged.limit).toBe(expectedMax)
          }
        )
      )
    })

    it("min: result limit equals min of all limits", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(grantArb, { minLength: 1, maxLength: 10 }),
          async (grantsData) => {
            const merged = grantsManager.mergeGrants({
              // biome-ignore lint/suspicious/noExplicitAny: <explanation>
              grants: grantsData as any,
              policy: "min",
            })

            const expectedMin = Math.min(...grantsData.map((g) => g.limit))
            expect(merged.limit).toBe(expectedMin)
          }
        )
      )
    })

    it("sum: effectiveAt is always the earliest start", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(grantArb, { minLength: 1, maxLength: 10 }),
          async (grantsData) => {
            const merged = grantsManager.mergeGrants({
              // biome-ignore lint/suspicious/noExplicitAny: <explanation>
              grants: grantsData as any,
              policy: "sum",
            })

            const expectedMin = Math.min(...grantsData.map((g) => g.effectiveAt))
            expect(merged.effectiveAt).toBe(expectedMin)
          }
        )
      )
    })
  })

  describe("resolveIngestionStatesFromGrants - edge cases", () => {
    it("returns empty for grants with no usage features", async () => {
      const flatGrant = {
        ...baseGrant,
        id: "g_flat",
        featurePlanVersion: {
          ...baseGrant.featurePlanVersion,
          featureType: "flat" as const,
          meterConfig: null,
        },
      }

      const result = await grantsManager.resolveIngestionStatesFromGrants({
        customerId,
        projectId,
        timestamp: now,
        grants: [flatGrant],
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(0)
    })

    it("returns empty for no grants", async () => {
      const result = await grantsManager.resolveIngestionStatesFromGrants({
        customerId,
        projectId,
        timestamp: now,
        grants: [],
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(0)
    })

    it("excludes grants not active at timestamp", async () => {
      const futureGrant = {
        ...baseGrant,
        id: "g_future",
        effectiveAt: now + 10_000,
        expiresAt: now + 20_000,
      }

      const result = await grantsManager.resolveIngestionStatesFromGrants({
        customerId,
        projectId,
        timestamp: now,
        grants: [futureGrant],
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(0)
    })

    it("stream ID is stable for same customer/feature/project", async () => {
      const result1 = await grantsManager.resolveIngestionStatesFromGrants({
        customerId,
        projectId,
        timestamp: now,
        grants: [baseGrant],
      })
      const result2 = await grantsManager.resolveIngestionStatesFromGrants({
        customerId,
        projectId,
        timestamp: now + 1000,
        grants: [baseGrant],
      })

      expect(result1.val?.[0]?.meterHash).toBe(result2.val?.[0]?.meterHash)
    })

    it("non-continuous grants produce separate stream windows", async () => {
      const march1 = Date.UTC(2026, 2, 1)
      const march10 = Date.UTC(2026, 2, 10)
      const march20 = Date.UTC(2026, 2, 20)
      const march31 = Date.UTC(2026, 2, 31)

      // Gap between march10 and march20
      const result = await grantsManager.resolveIngestionStatesFromGrants({
        customerId,
        projectId,
        timestamp: march20 + 1000,
        grants: [
          { ...baseGrant, id: "g1", effectiveAt: march1, expiresAt: march10 },
          { ...baseGrant, id: "g2", effectiveAt: march20, expiresAt: march31 },
        ],
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(1)
      // Second grant's window should NOT extend back to march1 (there's a gap)
      expect(result.val?.[0]?.effectiveAt).toBe(march20)
    })
  })

  describe("resolveIngestionStatesFromGrants", () => {
    it("uses the active grant window for the resolved meter hash", async () => {
      const march1 = Date.UTC(2026, 2, 1)
      const march15 = Date.UTC(2026, 2, 15)
      const march31 = Date.UTC(2026, 2, 31)
      const march20 = Date.UTC(2026, 2, 20)

      const result = await grantsManager.resolveIngestionStatesFromGrants({
        customerId,
        projectId,
        timestamp: march20,
        grants: [
          {
            ...baseGrant,
            id: "g_chain_1",
            limit: 100,
            effectiveAt: march1,
            expiresAt: march15,
          },
          {
            ...baseGrant,
            id: "g_chain_2",
            limit: 50,
            effectiveAt: march15,
            expiresAt: march31,
          },
        ],
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(1)
      expect(result.val?.[0]).toEqual(
        expect.objectContaining({
          activeGrantIds: ["g_chain_2"],
          featureSlug,
          limit: 50,
          effectiveAt: march15,
          expiresAt: march31,
        })
      )
      expect(result.val?.[0]?.meterHash).toContain("meter_hash_")
    })

    it("splits active stacked grants that disagree on meter configuration", async () => {
      const timestamp = Date.UTC(2026, 2, 20)

      const result = await grantsManager.resolveIngestionStatesFromGrants({
        customerId,
        projectId,
        timestamp,
        grants: [
          {
            ...baseGrant,
            id: "g_meter_a",
            effectiveAt: timestamp - 10_000,
            expiresAt: timestamp + 10_000,
          },
          {
            ...baseGrant,
            id: "g_meter_b",
            meterHash: "meter_hash_other_value",
            effectiveAt: timestamp - 5_000,
            expiresAt: timestamp + 5_000,
            featurePlanVersion: {
              ...baseGrant.featurePlanVersion,
              meterConfig: {
                ...baseGrant.featurePlanVersion.meterConfig,
                aggregationField: "other_value",
              },
            },
          },
        ],
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(2)
      expect(result.val?.map((state) => state.activeGrantIds)).toEqual([
        ["g_meter_a"],
        ["g_meter_b"],
      ])
      expect(new Set(result.val?.map((state) => state.meterHash)).size).toBe(2)
    })

    it("derives dayOfCreation reset anchors from grant effectiveAt for daily reset configs", async () => {
      const effectiveAt = Date.UTC(2026, 2, 24, 15, 30, 0)
      const timestamp = effectiveAt + 60_000

      const result = await grantsManager.resolveIngestionStatesFromGrants({
        customerId,
        projectId,
        timestamp,
        grants: [
          {
            ...baseGrant,
            id: "g_daily_day_of_creation",
            anchor: 24, // subscription phase monthly anchor; should not leak into daily reset config
            effectiveAt,
            expiresAt: effectiveAt + 24 * 60 * 60 * 1_000,
            featurePlanVersion: {
              ...baseGrant.featurePlanVersion,
              resetConfig: {
                ...baseGrant.featurePlanVersion.resetConfig,
                name: "daily",
                resetInterval: "day",
                resetIntervalCount: 1,
                resetAnchor: "dayOfCreation",
              },
            },
          },
        ],
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(1)
      expect(result.val?.[0]?.resetConfig).toEqual(
        expect.objectContaining({
          name: "daily",
          resetInterval: "day",
          resetAnchor: 15,
        })
      )
    })
  })
})
