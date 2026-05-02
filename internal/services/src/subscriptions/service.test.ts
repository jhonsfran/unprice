import type { Database } from "@unprice/db"
import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { DEFAULT_GRANT_PRIORITY } from "../entitlements/grants"
import { SubscriptionService } from "./service"

describe("SubscriptionService entitlement grant provisioning contract", () => {
  it("uses subscription grants as the default allowance chunk", () => {
    expect(DEFAULT_GRANT_PRIORITY.subscription).toBe(10)
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
      allowanceUnits: 100,
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
    const removeCustomerEntitlements = vi.fn().mockResolvedValue(undefined)
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
      cache: {
        customerRelevantEntitlements: {
          remove: removeCustomerEntitlements,
        },
      } as never,
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
