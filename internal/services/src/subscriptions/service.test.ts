import type { Database } from "@unprice/db"
import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { DEFAULT_GRANT_PRIORITY } from "../entitlements/grants"
import { SubscriptionService } from "./service"

describe("SubscriptionService entitlement grant provisioning contract", () => {
  it("uses subscription grants as the default allowance chunk", () => {
    expect(DEFAULT_GRANT_PRIORITY.subscription).toBe(10)
  })

  it("applies plan trial units even when no payment method id is present", async () => {
    const now = Date.parse("2026-05-02T12:00:00.000Z")
    const startAt = Date.parse("2026-05-03T12:00:00.000Z")
    const projectId = "proj_123"
    const subscriptionId = "sub_123"
    const featurePlanVersionId = "fpv_123"
    const insertPhase = vi.fn(async (phase) => phase)
    const insertItems = vi.fn().mockResolvedValue(undefined)
    const db = {
      query: {
        versions: {
          findFirst: vi.fn().mockResolvedValue({
            id: "version_123",
            status: "published",
            active: true,
            paymentMethodRequired: true,
            paymentProvider: "sandbox",
            trialUnits: 15,
            billingConfig: {
              name: "monthly",
              billingInterval: "month",
              billingIntervalCount: 1,
              planType: "recurring",
              billingAnchor: "dayOfCreation",
            },
            plan: { slug: "pro" },
            planFeatures: [
              {
                id: featurePlanVersionId,
                feature: { id: "feature_123" },
                limit: 3,
                metadata: { overageStrategy: "none" },
              },
            ],
          }),
        },
      },
    } as unknown as Database
    const repo = {
      findSubscriptionWithPhases: vi.fn().mockResolvedValue({
        id: subscriptionId,
        projectId,
        customerId: "cus_123",
        active: true,
        status: "active",
        phases: [],
      }),
      withTransaction: vi.fn(async (callback) =>
        callback({
          insertPhase,
          insertItems,
        })
      ),
    }
    const logger = {
      set: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }
    const service = new SubscriptionService({
      db,
      repo: repo as never,
      logger: logger as never,
      analytics: {} as never,
      waitUntil: vi.fn(),
      cache: {} as never,
      metrics: {} as never,
      customerService: {} as never,
      entitlementService: {} as never,
      billingService: {} as never,
      ratingService: {} as never,
      ledgerService: {} as never,
    })

    const result = await service.createPhase({
      input: {
        subscriptionId,
        planVersionId: "version_123",
        startAt,
        config: [
          {
            featurePlanId: featurePlanVersionId,
            units: 3,
            featureSlug: "api-requests",
          },
        ],
      } as never,
      projectId,
      db,
      now,
    })

    expect(result.err).toBeUndefined()
    expect(insertPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethodId: null,
        trialUnits: 15,
        trialEndsAt: Date.parse("2026-05-18T12:00:00.000Z"),
      })
    )
  })

  it("syncs new phase entitlements on the same transaction as the phase write", async () => {
    const now = Date.parse("2026-05-02T12:00:00.000Z")
    const projectId = "proj_123"
    const customerId = "cus_123"
    const subscriptionId = "sub_123"
    const phaseId = "phase_123"
    const featurePlanVersionId = "fpv_123"
    const grantReturning = vi.fn().mockResolvedValue([
      {
        id: "grant_123",
        projectId,
        customerEntitlementId: "ce_123",
        type: "subscription",
        priority: 10,
        allowanceUnits: 3,
        effectiveAt: now,
        expiresAt: null,
        metadata: null,
        createdAtM: now,
        updatedAtM: now,
      },
    ])
    const grantOnConflictDoNothing = vi.fn().mockReturnValue({ returning: grantReturning })
    const grantValues = vi.fn().mockReturnValue({ onConflictDoNothing: grantOnConflictDoNothing })
    const txDb = {
      insert: vi.fn().mockReturnValue({ values: grantValues }),
    } as unknown as Database
    const db = {
      query: {
        versions: {
          findFirst: vi.fn().mockResolvedValue({
            id: "version_123",
            status: "published",
            active: true,
            paymentMethodRequired: false,
            paymentProvider: "sandbox",
            billingConfig: {
              name: "standard",
              billingInterval: "month",
              billingIntervalCount: 1,
              planType: "recurring",
              billingAnchor: 1,
            },
            plan: { slug: "pro" },
            planFeatures: [
              {
                id: featurePlanVersionId,
                feature: { id: "feature_123" },
                limit: 3,
                metadata: { overageStrategy: "none" },
              },
            ],
          }),
        },
      },
    } as unknown as Database

    const phase = {
      id: phaseId,
      projectId,
      subscriptionId,
      planVersionId: "version_123",
      paymentMethodId: null,
      paymentProvider: "sandbox",
      trialEndsAt: null,
      trialUnits: 0,
      startAt: now,
      endAt: null,
      metadata: null,
      billingAnchor: 1,
    }
    const insertPhase = vi.fn().mockResolvedValue(phase)
    const insertItems = vi.fn().mockResolvedValue(undefined)
    const updateSubscription = vi.fn().mockResolvedValue({ id: subscriptionId })
    const txRepo = {
      insertPhase,
      insertItems,
      updateSubscription,
    }
    const repo = {
      findSubscriptionWithPhases: vi.fn().mockResolvedValue({
        id: subscriptionId,
        projectId,
        customerId,
        active: true,
        status: "active",
        phases: [],
      }),
      withTransaction: vi.fn(
        async (callback: (txRepo: unknown, txDb?: Database) => Promise<unknown>) =>
          callback(txRepo, txDb)
      ),
    }
    let createdEntitlement:
      | {
          id: string
          projectId: string
          customerId: string
          featurePlanVersionId: string
          subscriptionId: string | null
          subscriptionPhaseId: string | null
          subscriptionItemId: string | null
          effectiveAt: number
          expiresAt: number | null
          overageStrategy: "none"
          metadata: null
          createdAtM: number
          updatedAtM: number
        }
      | undefined
    const getPhaseOwnedEntitlements = vi
      .fn()
      .mockResolvedValueOnce(Ok([]))
      .mockImplementation(async () => Ok(createdEntitlement ? [createdEntitlement] : []))
    const createCustomerEntitlement = vi.fn().mockImplementation(async ({ entitlement }) => {
      createdEntitlement = {
        id: entitlement.id ?? "ce_123",
        projectId: entitlement.projectId,
        customerId: entitlement.customerId,
        featurePlanVersionId: entitlement.featurePlanVersionId,
        subscriptionId: entitlement.subscriptionId ?? null,
        subscriptionPhaseId: entitlement.subscriptionPhaseId ?? null,
        subscriptionItemId: entitlement.subscriptionItemId ?? null,
        effectiveAt: entitlement.effectiveAt,
        expiresAt: entitlement.expiresAt ?? null,
        overageStrategy: entitlement.overageStrategy ?? "none",
        metadata: null,
        createdAtM: now,
        updatedAtM: now,
      }

      return Ok(createdEntitlement)
    })
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      void promise
    })
    const updateAccessControlList = vi.fn().mockResolvedValue(undefined)
    const logger = {
      set: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }
    const service = new SubscriptionService({
      db,
      repo: repo as never,
      logger: logger as never,
      analytics: {} as never,
      waitUntil,
      cache: {} as never,
      metrics: {} as never,
      customerService: {
        updateAccessControlList,
      } as never,
      entitlementService: {
        getPhaseOwnedEntitlements,
        createCustomerEntitlement,
      } as never,
      billingService: {} as never,
      ratingService: {} as never,
      ledgerService: {} as never,
    })

    const result = await service.createPhase({
      input: {
        subscriptionId,
        planVersionId: "version_123",
        startAt: now,
        config: [
          {
            featurePlanId: featurePlanVersionId,
            units: 3,
            featureSlug: "api-requests",
          },
        ],
      } as never,
      projectId,
      db,
      now,
    })

    expect(result.err).toBeUndefined()
    expect(createCustomerEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        db: txDb,
        entitlement: expect.not.objectContaining({
          allowanceUnits: expect.anything(),
        }),
      })
    )
    expect(getPhaseOwnedEntitlements).toHaveBeenCalledWith(
      expect.objectContaining({
        db: txDb,
      })
    )
    expect(grantValues).toHaveBeenCalledWith(
      expect.objectContaining({
        allowanceUnits: 3,
        customerEntitlementId: createdEntitlement?.id,
      })
    )
  })

  it("cancels active phases by narrowing entitlements and grants in Postgres", async () => {
    const now = Date.parse("2026-05-02T12:00:00.000Z")
    const projectId = "proj_123"
    const customerId = "cus_123"
    const subscriptionId = "sub_123"
    const phaseId = "phase_123"
    const subscriptionItemId = "item_123"
    const featurePlanVersionId = "fpv_123"

    const grantWhere = vi.fn().mockResolvedValue(undefined)
    const grantSet = vi.fn().mockReturnValue({ where: grantWhere })
    const db = {
      update: vi.fn().mockReturnValue({ set: grantSet }),
    } as unknown as Database

    const activeEntitlement = {
      id: "ce_123",
      projectId,
      customerId,
      featurePlanVersionId,
      subscriptionId,
      subscriptionPhaseId: phaseId,
      subscriptionItemId,
      effectiveAt: now - 1000,
      expiresAt: null,
      overageStrategy: "none",
      metadata: null,
      createdAtM: now - 1000,
      updatedAtM: now - 1000,
    }

    const getPhaseOwnedEntitlements = vi.fn().mockResolvedValue(Ok([activeEntitlement]))
    const expireCustomerEntitlement = vi.fn().mockResolvedValue(
      Ok({
        ...activeEntitlement,
        expiresAt: now,
        updatedAtM: now,
      })
    )
    const updatePhase = vi.fn().mockResolvedValue({ id: phaseId, endAt: now })
    const canceledSubscription = {
      id: subscriptionId,
      projectId,
      customerId,
      active: false,
      status: "canceled",
      metadata: {
        reason: "cancelled",
        dates: {
          cancelAt: now,
        },
      },
    }
    const updateSubscription = vi.fn().mockResolvedValue(canceledSubscription)
    const repo = {
      findSubscriptionWithPhases: vi.fn().mockResolvedValue({
        id: subscriptionId,
        projectId,
        customerId,
        active: true,
        status: "active",
        metadata: {},
        phases: [
          {
            id: phaseId,
            projectId,
            startAt: now - 1000,
            endAt: null,
            items: [
              {
                id: subscriptionItemId,
                units: 100,
                featurePlanVersionId,
                featurePlanVersion: {
                  id: featurePlanVersionId,
                  limit: 100,
                  metadata: { overageStrategy: "none" },
                },
              },
            ],
          },
        ],
      }),
      withTransaction: vi.fn(async (callback) =>
        callback({
          updatePhase,
          updateSubscription,
        })
      ),
    }
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      void promise
    })
    const updateAccessControlList = vi.fn().mockResolvedValue(undefined)
    const logger = {
      set: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }
    const service = new SubscriptionService({
      db,
      repo: repo as never,
      logger: logger as never,
      analytics: {} as never,
      waitUntil,
      cache: {} as never,
      metrics: {} as never,
      customerService: {
        updateAccessControlList,
      } as never,
      entitlementService: {
        getPhaseOwnedEntitlements,
        expireCustomerEntitlement,
      } as never,
      billingService: {} as never,
      ratingService: {} as never,
      ledgerService: {} as never,
    })

    const result = await service.cancelSubscription({
      subscriptionId,
      projectId,
      now,
    })

    expect(result.err).toBeUndefined()
    if (!result.err) {
      expect(result.val).toEqual(canceledSubscription)
    }

    expect(updatePhase).toHaveBeenCalledWith({
      phaseId,
      data: { endAt: now },
    })
    expect(expireCustomerEntitlement).toHaveBeenCalledWith({
      id: activeEntitlement.id,
      projectId,
      expiresAt: now,
      db,
    })
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(grantSet).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: now,
      })
    )
    expect(updateSubscription).toHaveBeenCalledWith({
      subscriptionId,
      projectId,
      data: expect.objectContaining({
        active: false,
        status: "canceled",
        metadata: expect.objectContaining({
          reason: "cancelled",
          dates: {
            cancelAt: now,
          },
        }),
      }),
    })
    expect(updateAccessControlList).toHaveBeenCalledWith({
      customerId,
      projectId,
      updates: { subscriptionStatus: "canceled" },
    })
  })
})
