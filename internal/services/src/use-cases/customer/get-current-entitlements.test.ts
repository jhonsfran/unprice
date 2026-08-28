import type { CustomerEntitlementExtended } from "@unprice/db/validators"
import { FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { LEDGER_SCALE } from "@unprice/money"
import { describe, expect, it, vi } from "vitest"
import {
  type GetCustomerCurrentEntitlementsDeps,
  getCustomerCurrentEntitlements,
} from "./get-current-entitlements"

const now = Date.parse("2026-08-28T10:00:00.000Z")
const projectId = "proj_123"
const customerId = "cus_123"

describe("getCustomerCurrentEntitlements", () => {
  it("returns static allowance and live metered state", async () => {
    const usage = entitlement({
      id: "ce_tokens",
      featureSlug: "tokens",
      featureTitle: "Total tokens",
      featureType: "usage",
      limit: 2_000,
      meterConfig: meterConfig(),
      unitOfMeasure: "token",
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
    const getEnforcementState = vi.fn().mockResolvedValue({
      isLimitReached: false,
      limit: 2_000,
      usage: 1_400,
      quotaWindow: {
        periodKey: "month:1785542400000",
        startAt: Date.parse("2026-08-01T00:00:00.000Z"),
        endAt: Date.parse("2026-09-01T00:00:00.000Z"),
      },
      spending: {
        currency: "USD",
        ledgerAmount: 325_000_000,
        scale: LEDGER_SCALE,
      },
    })
    const deps = makeDeps({ entitlements: [usage, flat], getEnforcementState })

    const result = await getCustomerCurrentEntitlements(deps, { customerId, projectId })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({
      customerId,
      generatedAt: now,
      entitlements: [
        expect.objectContaining({
          status: "available",
          id: "ce_tokens",
          allowed: true,
          usage: 1_400,
          usagePercent: 70,
          spending: {
            currency: "USD",
            displayAmount: "$3.25",
            ledgerAmount: 325_000_000,
            scale: LEDGER_SCALE,
          },
        }),
        expect.objectContaining({
          status: "available",
          id: "ce_tools",
          allowed: true,
          limit: 1,
        }),
      ],
    })
    expect(getEnforcementState).toHaveBeenCalledTimes(1)
  })

  it("keeps successful rows when one durable object read fails", async () => {
    const first = entitlement({
      id: "ce_first",
      featureSlug: "first",
      featureTitle: "First",
      featureType: "usage",
      meterConfig: meterConfig(),
    })
    const second = entitlement({
      id: "ce_second",
      featureSlug: "second",
      featureTitle: "Second",
      featureType: "usage",
      meterConfig: meterConfig(),
    })
    const logger: Pick<Logger, "error"> = { error: vi.fn() }
    const deps = makeDeps({
      entitlements: [first, second],
      logger,
      getEnforcementState: vi
        .fn()
        .mockResolvedValueOnce({
          isLimitReached: false,
          limit: null,
          usage: 4,
          quotaWindow: null,
          spending: { currency: "USD", ledgerAmount: 0, scale: LEDGER_SCALE },
        })
        .mockRejectedValueOnce(new Error("DO unavailable")),
    })

    const result = await getCustomerCurrentEntitlements(deps, { customerId, projectId })

    expect(result.err).toBeUndefined()
    expect(result.val?.entitlements).toEqual([
      expect.objectContaining({ id: "ce_first", status: "available", usage: 4 }),
      expect.objectContaining({ id: "ce_second", status: "unavailable" }),
    ])
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        context: "current entitlement durable object read failed",
        customer_id: customerId,
        project_id: projectId,
        customer_entitlement_id: "ce_second",
      })
    )
  })

  it("does not hide invalid durable object state as an unavailable read", async () => {
    const metered = entitlement({
      id: "ce_tokens",
      featureSlug: "tokens",
      featureTitle: "Tokens",
      featureType: "usage",
      meterConfig: meterConfig(),
    })
    const deps = makeDeps({
      entitlements: [metered],
      getEnforcementState: vi.fn().mockResolvedValue({
        isLimitReached: false,
        limit: null,
        usage: 4,
        quotaWindow: null,
        spending: { currency: "invalid", ledgerAmount: 0, scale: LEDGER_SCALE },
      }),
    })

    await expect(getCustomerCurrentEntitlements(deps, { customerId, projectId })).rejects.toThrow()
    expect(deps.logger.error).not.toHaveBeenCalled()
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
    getEnforcementState?: ReturnType<typeof vi.fn>
    logger?: Pick<Logger, "error">
  } = {}
): GetCustomerCurrentEntitlementsDeps {
  const getEnforcementState =
    options.getEnforcementState ??
    vi.fn().mockResolvedValue({
      isLimitReached: false,
      limit: null,
      usage: 0,
      quotaWindow: null,
      spending: { currency: "USD", ledgerAmount: 0, scale: LEDGER_SCALE },
    })

  return {
    entitlements: {
      getCustomerEntitlementsForCustomer: vi
        .fn()
        .mockResolvedValue(options.entitlementResult ?? Ok(options.entitlements ?? [])),
    },
    entitlementWindowClient: {
      getEntitlementWindowStub: vi.fn().mockReturnValue({ getEnforcementState }),
    },
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
    eventSlug: "usage.recorded",
    aggregationMethod: "sum" as const,
    aggregationField: "amount",
  }
}
