import { describe, expect, it, vi } from "vitest"
import type { IngestionEntitlement } from "./entitlement-context"
import { IngestionFeatureVerifier } from "./feature-verification"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

function createIngestionGrant(
  overrides: Partial<IngestionEntitlement["grants"][number]> = {}
): IngestionEntitlement["grants"][number] {
  return {
    allowanceUnits: 100,
    cadenceEffectiveAt: TEST_NOW - 1_000,
    cadenceExpiresAt: null,
    currencyCode: "USD",
    effectiveAt: TEST_NOW - 1_000,
    expiresAt: null,
    grantId: "grant_123",
    priority: 10,
    resetConfig: null,
    ...overrides,
  }
}

describe("IngestionFeatureVerifier", () => {
  it("returns prepared context rejections that are not feature misses", async () => {
    const verifier = createVerifier({
      preparedContext: {
        candidateEntitlements: [],
        rejectionReason: "CUSTOMER_NOT_FOUND",
      },
    })

    await expect(verifier.verifyFeatureStatus(baseParams())).resolves.toEqual({
      allowed: false,
      featureSlug: "api_calls",
      rejectionReason: "CUSTOMER_NOT_FOUND",
    })
  })

  it("rejects duplicate active entitlements for one feature", async () => {
    const logger = createLogger()
    const verifier = createVerifier({
      logger,
      preparedContext: {
        candidateEntitlements: [
          createEntitlement({ customerEntitlementId: "ce_first" }),
          createEntitlement({ customerEntitlementId: "ce_second" }),
        ],
      },
    })

    await expect(verifier.verifyFeatureStatus(baseParams())).resolves.toEqual({
      allowed: false,
      featureSlug: "api_calls",
      rejectionReason: "INVALID_ENTITLEMENT_CONFIGURATION",
    })
    expect(logger.error).toHaveBeenCalledWith(
      "multiple active entitlements matched feature verification",
      expect.objectContaining({
        customerEntitlementIds: ["ce_first", "ce_second"],
      })
    )
  })

  it("returns static quantity limits without reading the entitlement window", async () => {
    const getEntitlementWindowStub = vi.fn()
    const verifier = createVerifier({
      entitlementWindowClient: { getEntitlementWindowStub },
      preparedContext: {
        candidateEntitlements: [
          createEntitlement({
            featureSlug: "seats",
            featureType: "tier",
            grants: [
              createIngestionGrant({
                allowanceUnits: 7,
                effectiveAt: TEST_NOW - 1_000,
                expiresAt: null,
                grantId: "grant_active",
                priority: 10,
              }),
              createIngestionGrant({
                allowanceUnits: 3,
                effectiveAt: TEST_NOW - 2_000,
                expiresAt: TEST_NOW - 1,
                grantId: "grant_expired",
                priority: 10,
              }),
            ],
            meterConfig: null,
          }),
        ],
      },
    })

    await expect(
      verifier.verifyFeatureStatus(baseParams({ featureSlug: "seats" }))
    ).resolves.toEqual({
      allowed: true,
      featureSlug: "seats",
      limit: 7,
    })
    expect(getEntitlementWindowStub).not.toHaveBeenCalled()
  })

  it("returns null static quantity limit when an active grant is unlimited", async () => {
    const verifier = createVerifier({
      preparedContext: {
        candidateEntitlements: [
          createEntitlement({
            featureSlug: "seats",
            featureType: "package",
            grants: [
              createIngestionGrant({
                allowanceUnits: null,
                effectiveAt: TEST_NOW - 1_000,
                expiresAt: null,
                grantId: "grant_unlimited",
                priority: 10,
              }),
            ],
            meterConfig: null,
          }),
        ],
      },
    })

    await expect(
      verifier.verifyFeatureStatus(baseParams({ featureSlug: "seats" }))
    ).resolves.toEqual({
      allowed: true,
      featureSlug: "seats",
      limit: null,
    })
  })

  it("reads usage enforcement state and formats spending", async () => {
    const entitlement = createEntitlement()
    const getEnforcementState = vi.fn().mockResolvedValue({
      usage: 100,
      limit: 100,
      isLimitReached: true,
      spending: {
        currency: "USD",
        ledgerAmount: 10_000_000_000,
        scale: 8,
      },
    })
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      getEnforcementState,
    })
    const verifier = createVerifier({
      entitlementWindowClient: { getEntitlementWindowStub },
      preparedContext: {
        candidateEntitlements: [entitlement],
      },
    })

    await expect(verifier.verifyFeatureStatus(baseParams())).resolves.toMatchObject({
      allowed: false,
      featureSlug: "api_calls",
      limit: 100,
      rejectionReason: "LIMIT_EXCEEDED",
      spending: {
        currency: "USD",
        displayAmount: "$100",
        ledgerAmount: 10_000_000_000,
        scale: 8,
      },
      usage: 100,
    })
    expect(getEntitlementWindowStub).toHaveBeenCalledWith({
      customerEntitlementId: entitlement.customerEntitlementId,
      customerId: "cus_123",
      projectId: "proj_123",
    })
    expect(getEnforcementState).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlement: expect.objectContaining({
          meterConfig: entitlement.meterConfig,
        }),
        grants: entitlement.grants,
        now: TEST_NOW,
      })
    )
  })
})

function createVerifier(
  overrides: {
    entitlementWindowClient?: unknown
    logger?: ReturnType<typeof createLogger>
    preparedContext?: {
      candidateEntitlements: IngestionEntitlement[]
      rejectionReason?: "CUSTOMER_NOT_FOUND" | "NO_MATCHING_ENTITLEMENT"
    }
  } = {}
) {
  return new IngestionFeatureVerifier({
    entitlementContext: {
      prepareCustomerGrantContext: vi.fn().mockResolvedValue(
        overrides.preparedContext ?? {
          candidateEntitlements: [createEntitlement()],
        }
      ),
    },
    entitlementWindowClient:
      overrides.entitlementWindowClient ??
      ({
        getEntitlementWindowStub: vi.fn().mockReturnValue({
          getEnforcementState: vi.fn(),
        }),
      } as never),
    logger: overrides.logger ?? createLogger(),
  } as never)
}

function createLogger() {
  return {
    error: vi.fn(),
  }
}

function baseParams(
  overrides: Partial<Parameters<IngestionFeatureVerifier["verifyFeatureStatus"]>[0]> = {}
) {
  return {
    customerId: "cus_123",
    featureSlug: "api_calls",
    projectId: "proj_123",
    timestamp: TEST_NOW,
    ...overrides,
  }
}

function createEntitlement(overrides: Partial<IngestionEntitlement> = {}): IngestionEntitlement {
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
    featureSlug: "api_calls",
    featureType: "usage",
    grants: [],
    meterConfig: {
      eventId: "evt_usage",
      eventSlug: "usage.recorded",
      aggregationMethod: "sum",
      aggregationField: "amount",
    },
    overageStrategy: "none",
    projectId: "proj_123",
    resetConfig: null,
    subscriptionItemId: null,
    ...overrides,
  }
}
