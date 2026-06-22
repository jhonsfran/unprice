import type { MeterConfig } from "@unprice/db/validators"
import { describe, expect, it, vi } from "vitest"
import { INGESTION_MAX_EVENT_AGE_MS } from "../entitlements"
import type {
  CustomerGrantContextReader,
  IngestionBillingPeriodContext,
  IngestionEntitlement,
} from "./entitlement-context"
import { IngestionRunEntitlementResolver } from "./run-entitlement-resolver"

const TEST_NOW = Date.UTC(2026, 5, 22, 11, 13, 15)

describe("IngestionRunEntitlementResolver", () => {
  it("runs subscription catch-up and reloads context when no billing period covers the event", async () => {
    const beforeCatchUp = createEntitlement({ billingPeriods: [] })
    const afterCatchUp = createEntitlement({
      billingPeriods: [
        createBillingPeriod({
          cycleStartAt: TEST_NOW - 1_000,
          cycleEndAt: TEST_NOW + 1_000,
        }),
      ],
    })
    const prepareCustomerGrantContext = vi
      .fn<CustomerGrantContextReader["prepareCustomerGrantContext"]>()
      .mockResolvedValueOnce({ candidateEntitlements: [beforeCatchUp] })
      .mockResolvedValueOnce({ candidateEntitlements: [afterCatchUp] })
    const catchUpForPreparedGroup = vi.fn().mockResolvedValue({
      changed: true,
      caughtUpSubscriptionIds: ["sub_123"],
    })
    const resolver = createResolver({
      catchUpForPreparedGroup,
      prepareCustomerGrantContext,
    })

    const result = await resolver.resolveForFeature(createResolveInput())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.entitlement.billingPeriods).toEqual(afterCatchUp.billingPeriods)
      expect(result.grants).toBe(afterCatchUp.grants)
    }
    expect(prepareCustomerGrantContext).toHaveBeenCalledTimes(2)
    expect(prepareCustomerGrantContext).toHaveBeenNthCalledWith(1, {
      customerId: "cus_123",
      projectId: "proj_123",
      startAt: Math.max(0, TEST_NOW - INGESTION_MAX_EVENT_AGE_MS),
      endAt: TEST_NOW,
    })
    expect(catchUpForPreparedGroup).toHaveBeenCalledWith({
      candidateEntitlements: [beforeCatchUp],
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [
        expect.objectContaining({
          customerId: "cus_123",
          projectId: "proj_123",
          slug: "usage.recorded",
          timestamp: TEST_NOW,
          properties: { tokens: 1 },
        }),
      ],
    })
  })

  it("does not run subscription catch-up when a billing period already covers the event", async () => {
    const entitlement = createEntitlement({
      billingPeriods: [
        createBillingPeriod({
          cycleStartAt: TEST_NOW - 1_000,
          cycleEndAt: TEST_NOW + 1_000,
        }),
      ],
    })
    const prepareCustomerGrantContext = vi
      .fn<CustomerGrantContextReader["prepareCustomerGrantContext"]>()
      .mockResolvedValue({ candidateEntitlements: [entitlement] })
    const catchUpForPreparedGroup = vi.fn()
    const resolver = createResolver({
      catchUpForPreparedGroup,
      prepareCustomerGrantContext,
    })

    const result = await resolver.resolveForFeature(createResolveInput())

    expect(result.ok).toBe(true)
    expect(prepareCustomerGrantContext).toHaveBeenCalledTimes(1)
    expect(catchUpForPreparedGroup).not.toHaveBeenCalled()
  })
})

function createResolver(params: {
  catchUpForPreparedGroup: ReturnType<typeof vi.fn>
  prepareCustomerGrantContext: CustomerGrantContextReader["prepareCustomerGrantContext"]
}) {
  return new IngestionRunEntitlementResolver({
    entitlementContext: {
      prepareCustomerGrantContext: params.prepareCustomerGrantContext,
    },
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
    },
    subscriptionCatchUp: {
      catchUpForPreparedGroup: params.catchUpForPreparedGroup,
    },
  })
}

function createResolveInput() {
  return {
    projectId: "proj_123",
    customerId: "cus_123",
    featureSlug: "tokens",
    eventSlug: "usage.recorded",
    eventTimestamp: TEST_NOW,
    eventProperties: { tokens: 1 },
  }
}

function createBillingPeriod(
  overrides: Partial<IngestionBillingPeriodContext> = {}
): IngestionBillingPeriodContext {
  return {
    billingPeriodId: "bp_123",
    cycleStartAt: TEST_NOW - 1_000,
    cycleEndAt: TEST_NOW + 1_000,
    featurePlanVersionItemId: "si_123",
    statementKey: "statement_123",
    ...overrides,
  }
}

function createEntitlement(
  overrides: Partial<Omit<IngestionEntitlement, "meterConfig">> & { meterConfig?: MeterConfig } = {}
): IngestionEntitlement & { meterConfig: MeterConfig } {
  const meterConfig: MeterConfig = overrides.meterConfig ?? {
    eventId: "evt_usage",
    eventSlug: "usage.recorded",
    aggregationMethod: "sum",
    aggregationField: "tokens",
  }

  return {
    billingPeriods: [],
    creditLinePolicy: "capped",
    customerEntitlementId: "ce_123",
    customerId: "cus_123",
    effectiveAt: TEST_NOW - 1_000,
    expiresAt: null,
    featureConfig: {
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
    featurePlanVersionId: "fpv_123",
    featureSlug: "tokens",
    featureType: "usage",
    grants: [],
    meterConfig,
    overageStrategy: "none",
    projectId: "proj_123",
    resetConfig: null,
    subscriptionId: "sub_123",
    subscriptionItemId: "si_123",
    ...overrides,
  }
}
