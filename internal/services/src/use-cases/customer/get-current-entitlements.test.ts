import type { CustomerEntitlementExtended } from "@unprice/db/validators"
import { FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { BudgetClient } from "../budgets/budget-client"
import { meterPayerUsage } from "../budgets/meter-payer-usage"
import { DEC, NOV, PROJECT_ID, image, payerHarness } from "../budgets/payer-budget.fixture"
import {
  type GetCustomerCurrentEntitlementsDeps,
  getCustomerCurrentEntitlements,
} from "./get-current-entitlements"

const now = NOV + 3_600_000
const projectId = PROJECT_ID
const customerId = "cus_123"

describe("getCustomerCurrentEntitlements", () => {
  it("returns static allowance and live metered state from the payer budget", async () => {
    const h = payerHarness()
    await h.createPayer(customerId, { imagesLimit: 4 })
    await meterPayerUsage(h.deps, {
      verb: "record",
      receivedAt: now,
      events: [
        { projectId, customerId, idempotencyKey: "e1", occurredAt: NOV + 1, ...image("1024") },
        { projectId, customerId, idempotencyKey: "e2", occurredAt: NOV + 2, ...image("512") },
      ],
    })
    const images = entitlement({
      id: "ce_images",
      featureSlug: "images",
      featureTitle: "Images",
      featureType: "usage",
      meterConfig: meterConfig(),
      unitOfMeasure: "image",
    })
    const flat = entitlement({
      id: "ce_tools",
      featureSlug: "tools",
      featureTitle: "Artifact tools",
      featureType: "flat",
      limit: null,
      meterConfig: null,
      unitOfMeasure: "access",
    })
    const deps = makeDeps({ entitlements: [images, flat], budgets: h.budgets })

    const result = await getCustomerCurrentEntitlements(deps, { customerId, projectId })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({
      customerId,
      generatedAt: now,
      entitlements: [
        {
          id: "ce_images",
          featureSlug: "images",
          featureTitle: "Images",
          featureType: "usage",
          unitOfMeasure: "image",
          grantCount: 1,
          status: "available",
          allowed: true,
          limit: 4,
          usage: 2,
          usagePercent: 50,
          quotaWindow: { periodKey: "images:month", startAt: NOV, endAt: DEC },
          spending: { unit: "money:USD", amount: "0.058" },
        },
        expect.objectContaining({
          status: "available",
          id: "ce_tools",
          allowed: true,
          limit: 1,
        }),
      ],
    })
  })

  it("reports billing-period usage when the metered feature has no limit", async () => {
    const h = payerHarness()
    await h.createPayer(customerId)
    await meterPayerUsage(h.deps, {
      verb: "record",
      receivedAt: now,
      events: [
        { projectId, customerId, idempotencyKey: "e1", occurredAt: NOV + 1, ...image("512") },
      ],
    })
    const deps = makeDeps({
      entitlements: [
        entitlement({
          id: "ce_images",
          featureSlug: "images",
          featureTitle: "Images",
          featureType: "usage",
          meterConfig: meterConfig(),
        }),
      ],
      budgets: h.budgets,
    })

    const result = await getCustomerCurrentEntitlements(deps, { customerId, projectId })

    expect(result.val?.entitlements).toEqual([
      expect.objectContaining({
        status: "available",
        limit: null,
        usage: 1,
        usagePercent: null,
        quotaWindow: { periodKey: "images:bp_nov", startAt: NOV, endAt: DEC },
      }),
    ])
  })

  it("marks metered rows unavailable when the payer budget read fails", async () => {
    const logger: Pick<Logger, "error"> = { error: vi.fn() }
    const budgets: BudgetClient = {
      execute: vi.fn().mockRejectedValue(new Error("DO unavailable")),
      cacheCards: vi.fn(),
    }
    const deps = makeDeps({
      entitlements: [
        entitlement({
          id: "ce_first",
          featureSlug: "first",
          featureTitle: "First",
          featureType: "usage",
          meterConfig: meterConfig(),
        }),
      ],
      budgets,
      logger,
    })

    const result = await getCustomerCurrentEntitlements(deps, { customerId, projectId })

    expect(result.val?.entitlements).toEqual([
      expect.objectContaining({ id: "ce_first", status: "unavailable" }),
    ])
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        context: "payer budget read failed",
        customer_id: customerId,
        project_id: projectId,
      })
    )
  })

  it("marks metered rows unavailable, without an error, before billing creates the budget", async () => {
    const h = payerHarness()
    const deps = makeDeps({
      entitlements: [
        entitlement({
          id: "ce_first",
          featureSlug: "first",
          featureTitle: "First",
          featureType: "usage",
          meterConfig: meterConfig(),
        }),
      ],
      budgets: h.budgets,
    })

    const result = await getCustomerCurrentEntitlements(deps, { customerId, projectId })

    expect(result.val?.entitlements).toEqual([
      expect.objectContaining({ id: "ce_first", status: "unavailable" }),
    ])
    expect(deps.logger.error).not.toHaveBeenCalled()
  })

  it("reads no budget when no entitlement is metered", async () => {
    const execute = vi.fn()
    const deps = makeDeps({
      entitlements: [
        entitlement({
          id: "ce_tools",
          featureSlug: "tools",
          featureTitle: "Tools",
          featureType: "flat",
          meterConfig: null,
        }),
      ],
      budgets: { execute, cacheCards: vi.fn() },
    })

    await getCustomerCurrentEntitlements(deps, { customerId, projectId })

    expect(execute).not.toHaveBeenCalled()
  })

  it("returns the entitlement query failure", async () => {
    const failure = new FetchError({ message: "database unavailable", retry: true })
    const deps = makeDeps({ entitlementResult: { err: failure } })

    const result = await getCustomerCurrentEntitlements(deps, { customerId, projectId })

    expect(result.err).toBe(failure)
  })
})

function makeDeps(
  options: {
    entitlements?: CustomerEntitlementExtended[]
    entitlementResult?: { err: FetchError }
    budgets?: BudgetClient
    logger?: Pick<Logger, "error">
  } = {}
): GetCustomerCurrentEntitlementsDeps {
  return {
    entitlements: {
      getCustomerEntitlementsForCustomer: vi
        .fn()
        .mockResolvedValue(options.entitlementResult ?? Ok(options.entitlements ?? [])),
    },
    budgets: options.budgets ?? payerHarness().budgets,
    logger: options.logger ?? { error: vi.fn() },
    now: () => now,
  }
}

function entitlement(options: {
  id: string
  featureSlug: string
  featureTitle: string
  featureType: "flat" | "tier" | "package" | "usage"
  limit?: number | null
  meterConfig: ReturnType<typeof meterConfig> | null
  unitOfMeasure?: string
}): CustomerEntitlementExtended {
  return {
    id: options.id,
    projectId,
    customerId,
    featurePlanVersionId: `fpv_${options.featureSlug}`,
    subscriptionId: "sub_123",
    subscriptionPhaseId: "phase_123",
    subscriptionItemId: `item_${options.featureSlug}`,
    effectiveAt: now - 1_000,
    expiresAt: null,
    overageStrategy: "none",
    metadata: null,
    createdAtM: now - 1_000,
    updatedAtM: now - 1_000,
    subscriptionPhase: { creditLinePolicy: "uncapped" },
    featurePlanVersion: {
      included: null,
      id: `fpv_${options.featureSlug}`,
      projectId,
      planVersionId: "pv_123",
      featureId: `feature_${options.featureSlug}`,
      featureType: options.featureType,
      config: {
        usageMode: "unit",
        price: {
          dinero: {
            amount: 0,
            currency: { code: "USD", base: 10, exponent: 2 },
            scale: 2,
          },
          displayAmount: "0.00",
        },
      },
      limit: options.limit ?? null,
      meterConfig: options.meterConfig,
      resetConfig: null,
      unitOfMeasure: options.unitOfMeasure ?? "unit",
      metadata: {
        overageStrategy: "none",
        realtime: true,
        notifyUsageThreshold: 80,
        blockCustomer: false,
        hidden: false,
      },
      defaultQuantity: 1,
      type: "feature",
      order: 0,
      createdAtM: now - 1_000,
      updatedAtM: now - 1_000,
      feature: {
        code: 1,
        id: `feature_${options.featureSlug}`,
        projectId,
        slug: options.featureSlug,
        title: options.featureTitle,
        description: null,
        unitOfMeasure: options.unitOfMeasure ?? "unit",
        meterConfig: options.meterConfig,
        createdAtM: now - 1_000,
        updatedAtM: now - 1_000,
      },
      billingConfig: {
        name: "monthly",
        planType: "recurring",
        billingInterval: "month",
        billingIntervalCount: 1,
        billingAnchor: "dayOfCreation",
      },
    },
    grants: [
      {
        id: `grant_${options.featureSlug}`,
        projectId,
        customerEntitlementId: options.id,
        type: "subscription",
        priority: 0,
        allowanceUnits: 1,
        effectiveAt: now - 1_000,
        expiresAt: null,
        metadata: null,
        createdAtM: now - 1_000,
        updatedAtM: now - 1_000,
      },
    ],
  }
}

function meterConfig() {
  return {
    eventId: "evt_usage",
    eventSlug: "image.generated",
    aggregationMethod: "sum" as const,
    aggregationField: "amount",
  }
}
