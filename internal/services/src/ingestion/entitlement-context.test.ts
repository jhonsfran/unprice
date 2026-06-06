import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { INGESTION_MAX_EVENT_AGE_MS } from "../entitlements"
import {
  type IngestionEntitlement,
  IngestionEntitlementContextLoader,
  resolveCustomerGrantContextWindow,
  toIngestionEntitlement,
} from "./entitlement-context"
import type { IngestionQueueMessage } from "./message"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("IngestionEntitlementContextLoader", () => {
  it("resolves the reusable grant-context lookback window", () => {
    expect(
      resolveCustomerGrantContextWindow({
        earliestTimestamp: TEST_NOW,
        latestTimestamp: TEST_NOW + 1_000,
      })
    ).toEqual({
      startAt: TEST_NOW - INGESTION_MAX_EVENT_AGE_MS,
      endAt: TEST_NOW + 1_000,
    })

    expect(
      resolveCustomerGrantContextWindow({
        earliestTimestamp: INGESTION_MAX_EVENT_AGE_MS - 1,
        latestTimestamp: TEST_NOW,
      }).startAt
    ).toBe(0)
  })

  it("maps customer entitlement records into ingestion entitlements", () => {
    const entitlement = createEntitlement({
      grants: [
        {
          allowanceUnits: null,
          effectiveAt: TEST_NOW - 1_000,
          expiresAt: TEST_NOW + 1_000,
          grantId: "grant_unlimited",
          priority: 20,
        },
      ],
    })

    const mapped = toIngestionEntitlement(createCustomerEntitlementRecord(entitlement) as never)

    expect(mapped).toMatchObject({
      billingPeriods: [],
      creditLinePolicy: "capped",
      customerEntitlementId: "ce_123",
      featureSlug: "api_calls",
      featureType: "usage",
      meterConfig: entitlement.meterConfig,
      resetConfig: {
        name: "monthly",
        resetAnchor: "dayOfCreation",
        resetInterval: "month",
        resetIntervalCount: 1,
        planType: "recurring",
      },
      grants: [
        {
          allowanceUnits: null,
          grantId: "grant_unlimited",
          priority: 20,
        },
      ],
      subscriptionItemId: null,
    })
  })

  it("returns cached prepared context without loading entitlements", async () => {
    const cachedContext = {
      candidateEntitlements: [createEntitlement()],
    }
    const getCustomerEntitlementsForCustomer = vi.fn()
    const loader = createLoader({
      cache: {
        ingestionPreparedGrantContext: {
          swr: vi.fn().mockResolvedValue({ val: cachedContext }),
        },
      },
      entitlementService: {
        getCustomerEntitlementsForCustomer,
        customerExists: vi.fn(),
      },
    })

    const result = await loader.prepareCustomerGrantContext({
      customerId: "cus_123",
      projectId: "proj_123",
      startAt: TEST_NOW - 1_000,
      endAt: TEST_NOW,
    })

    expect(result).toEqual({
      candidateEntitlements: [
        {
          ...cachedContext.candidateEntitlements[0],
          billingPeriods: [],
        },
      ],
    })
    expect(getCustomerEntitlementsForCustomer).not.toHaveBeenCalled()
  })

  it("falls back to direct entitlement load when the cache returns an error", async () => {
    const logger = createLogger()
    const entitlement = createEntitlement()
    const getCustomerEntitlementsForCustomer = vi
      .fn()
      .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never))
    const loader = createLoader({
      cache: {
        ingestionPreparedGrantContext: {
          swr: vi.fn().mockResolvedValue({ err: new Error("cache unavailable") }),
        },
      },
      entitlementService: {
        getCustomerEntitlementsForCustomer,
        customerExists: vi.fn(),
      },
      logger,
    })

    const result = await loader.prepareCustomerGrantContext({
      customerId: "cus_123",
      projectId: "proj_123",
      startAt: TEST_NOW - 1_000,
      endAt: TEST_NOW,
    })

    expect(result.candidateEntitlements).toHaveLength(1)
    expect(result.rejectionReason).toBeUndefined()
    expect(getCustomerEntitlementsForCustomer).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      "failed to use cached entitlement context, falling back to direct load",
      expect.objectContaining({
        customerId: "cus_123",
        projectId: "proj_123",
      })
    )
  })

  it("distinguishes a missing customer from a customer with no matching entitlement", async () => {
    const missingCustomerLoader = createLoader({
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi.fn().mockResolvedValue(Ok([])),
        customerExists: vi.fn().mockResolvedValue(Ok(false)),
      },
    })
    const customerWithoutEntitlementsLoader = createLoader({
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi.fn().mockResolvedValue(Ok([])),
        customerExists: vi.fn().mockResolvedValue(Ok(true)),
      },
    })

    await expect(
      missingCustomerLoader.prepareCustomerGrantContext({
        customerId: "cus_123",
        projectId: "proj_123",
        startAt: TEST_NOW - 1_000,
        endAt: TEST_NOW,
      })
    ).resolves.toMatchObject({ rejectionReason: "CUSTOMER_NOT_FOUND" })

    await expect(
      customerWithoutEntitlementsLoader.prepareCustomerGrantContext({
        customerId: "cus_123",
        projectId: "proj_123",
        startAt: TEST_NOW - 1_000,
        endAt: TEST_NOW,
      })
    ).resolves.toMatchObject({ rejectionReason: "NO_MATCHING_ENTITLEMENT" })
  })

  it("prepares message groups over the event timestamp range", async () => {
    const getCustomerEntitlementsForCustomer = vi
      .fn()
      .mockResolvedValue(Ok([createCustomerEntitlementRecord(createEntitlement())] as never))
    const loader = createLoader({
      entitlementService: {
        getCustomerEntitlementsForCustomer,
        customerExists: vi.fn(),
      },
    })
    const firstMessage = createMessage({ id: "evt_1", timestamp: TEST_NOW - 10_000 })
    const secondMessage = createMessage({ id: "evt_2", timestamp: TEST_NOW })

    const result = await loader.prepareCustomerMessageGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [firstMessage, secondMessage],
    })

    expect(result.messages).toEqual([firstMessage, secondMessage])
    expect(getCustomerEntitlementsForCustomer).toHaveBeenCalledWith({
      customerId: "cus_123",
      projectId: "proj_123",
      startAt: Math.max(0, firstMessage.timestamp - INGESTION_MAX_EVENT_AGE_MS),
      endAt: secondMessage.timestamp,
    })
  })
})

function createLoader(
  overrides: {
    cache?: unknown
    entitlementService?: unknown
    logger?: ReturnType<typeof createLogger>
  } = {}
) {
  return new IngestionEntitlementContextLoader({
    cache: overrides.cache ?? createCache(),
    entitlementService:
      overrides.entitlementService ??
      ({
        getCustomerEntitlementsForCustomer: vi.fn().mockResolvedValue(Ok([])),
        customerExists: vi.fn().mockResolvedValue(Ok(true)),
      } as never),
    logger: overrides.logger ?? createLogger(),
  } as never)
}

function createCache() {
  return {
    ingestionPreparedGrantContext: {
      swr: async (_key: string, loader: () => Promise<unknown>) => ({ val: await loader() }),
    },
  }
}

function createLogger() {
  return {
    warn: vi.fn(),
  }
}

function createMessage(overrides: Partial<IngestionQueueMessage> = {}): IngestionQueueMessage {
  return {
    version: 1,
    workspaceId: "ws_123",
    projectId: "proj_123",
    customerId: "cus_123",
    requestId: "req_123",
    receivedAt: TEST_NOW,
    idempotencyKey: "idem_123",
    id: "evt_123",
    slug: "usage.recorded",
    timestamp: TEST_NOW,
    properties: { amount: 1 },
    source: {
      environment: "test",
      apiKeyId: "key_123",
      sourceType: "api_key",
      sourceId: "key_123",
      sourceName: null,
    },
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

function createCustomerEntitlementRecord(entitlement: IngestionEntitlement) {
  return {
    id: entitlement.customerEntitlementId,
    projectId: entitlement.projectId,
    customerId: entitlement.customerId,
    featurePlanVersionId: entitlement.featurePlanVersionId,
    subscriptionId: null,
    subscriptionPhaseId: null,
    subscriptionItemId: null,
    effectiveAt: entitlement.effectiveAt,
    expiresAt: entitlement.expiresAt,
    overageStrategy: entitlement.overageStrategy,
    metadata: null,
    createdAtM: 0,
    updatedAtM: 0,
    subscriptionPhase: {
      creditLinePolicy: entitlement.creditLinePolicy,
    },
    grants: toGrantRecords(entitlement),
    featurePlanVersion: {
      id: entitlement.featurePlanVersionId,
      projectId: entitlement.projectId,
      planVersionId: "version_123",
      type: "feature",
      featureId: "feature_123",
      featureType: entitlement.featureType,
      unitOfMeasure: "units",
      config: entitlement.featureConfig,
      billingConfig: {
        name: "monthly",
        billingInterval: "month",
        billingIntervalCount: 1,
        billingAnchor: "dayOfCreation",
        planType: "recurring",
      },
      resetConfig: entitlement.resetConfig,
      metadata: null,
      order: 1,
      defaultQuantity: 1,
      limit: 100,
      meterConfig: entitlement.meterConfig,
      createdAtM: 0,
      updatedAtM: 0,
      feature: {
        id: "feature_123",
        projectId: entitlement.projectId,
        slug: entitlement.featureSlug,
        type: entitlement.featureType,
        title: "API calls",
        description: null,
        metadata: null,
        createdAtM: 0,
        updatedAtM: 0,
      },
    },
  }
}

function toGrantRecords(entitlement: IngestionEntitlement) {
  return entitlement.grants.map((grant) => ({
    id: grant.grantId,
    projectId: entitlement.projectId,
    customerEntitlementId: entitlement.customerEntitlementId,
    type: "subscription",
    priority: grant.priority,
    allowanceUnits: grant.allowanceUnits,
    effectiveAt: grant.effectiveAt,
    expiresAt: grant.expiresAt,
    metadata: null,
    createdAtM: 0,
    updatedAtM: 0,
  }))
}
