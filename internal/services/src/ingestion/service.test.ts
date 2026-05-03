import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { INGESTION_MAX_EVENT_AGE_MS } from "../entitlements"
import { type IngestionEntitlement, IngestionService } from "./service"

const SERVICE_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("IngestionService entitlement routing", () => {
  it("loads customer entitlements and routes by customerEntitlementId", async () => {
    const entitlement = createEntitlement()
    const apply = vi.fn().mockResolvedValue({ allowed: true })
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply,
      getEnforcementState: vi.fn(),
    })
    const commit = vi.fn().mockResolvedValue({ inserted: 1, duplicates: 0, conflicts: 0 })

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi.fn().mockResolvedValue(
          Ok([
            {
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
              grants: [
                {
                  id: "grant_123",
                  projectId: entitlement.projectId,
                  customerEntitlementId: entitlement.customerEntitlementId,
                  type: "subscription",
                  priority: 10,
                  allowanceUnits: 100,
                  effectiveAt: entitlement.effectiveAt,
                  expiresAt: entitlement.expiresAt,
                  metadata: null,
                  createdAtM: 0,
                  updatedAtM: 0,
                },
              ],
              featurePlanVersion: {
                id: entitlement.featurePlanVersionId,
                projectId: entitlement.projectId,
                planVersionId: "version_123",
                type: "feature",
                featureId: "feature_123",
                featureType: "usage",
                unitOfMeasure: "units",
                config: entitlement.featureConfig,
                billingConfig: {
                  name: "monthly",
                  billingInterval: "month",
                  billingIntervalCount: 1,
                  billingAnchor: "dayOfCreation",
                  planType: "recurring",
                },
                resetConfig: null,
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
                  type: "usage",
                  title: "API calls",
                  description: null,
                  metadata: null,
                  createdAtM: 0,
                  updatedAtM: 0,
                },
              },
            },
          ] as never)
        ),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      auditClient: {
        getAuditStub: vi.fn().mockReturnValue({
          commit,
          exists: vi.fn().mockResolvedValue([]),
        }),
      },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
      waitUntil: vi.fn(),
    })

    const result = await service.ingestFeatureSync({
      featureSlug: entitlement.featureSlug,
      message: {
        version: 1,
        projectId: entitlement.projectId,
        customerId: entitlement.customerId,
        requestId: "req_123",
        receivedAt: Date.now(),
        idempotencyKey: "idem_123",
        id: "evt_123",
        slug: "usage.recorded",
        timestamp: Date.UTC(2026, 2, 19),
        properties: { amount: 1 },
      },
    })

    expect(result.allowed).toBe(true)
    expect(getEntitlementWindowStub).toHaveBeenCalledWith({
      customerEntitlementId: entitlement.customerEntitlementId,
      customerId: entitlement.customerId,
      projectId: entitlement.projectId,
    })
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlement: expect.objectContaining({
          customerEntitlementId: entitlement.customerEntitlementId,
        }),
        grants: [
          expect.objectContaining({
            grantId: "grant_123",
            allowanceUnits: 100,
          }),
        ],
      })
    )
  })

  it("rejects duplicate active entitlements for the same customer feature", async () => {
    const entitlement = createEntitlement()
    const apply = vi.fn().mockResolvedValue({ allowed: true })
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply,
      getEnforcementState: vi.fn(),
    })
    const logger = createLogger()

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi.fn().mockResolvedValue(
          Ok([
            createCustomerEntitlementRecord(entitlement),
            createCustomerEntitlementRecord({
              ...entitlement,
              customerEntitlementId: "ce_duplicate",
              featurePlanVersionId: "fpv_duplicate",
            }),
          ] as never)
        ),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      auditClient: {
        getAuditStub: vi.fn().mockReturnValue({
          commit: vi.fn().mockResolvedValue({ inserted: 1, duplicates: 0, conflicts: 0 }),
          exists: vi.fn().mockResolvedValue([]),
        }),
      },
      logger: logger as never,
      now: () => SERVICE_NOW,
      waitUntil: vi.fn(),
    })

    const result = await service.ingestFeatureSync({
      featureSlug: entitlement.featureSlug,
      message: {
        version: 1,
        projectId: entitlement.projectId,
        customerId: entitlement.customerId,
        requestId: "req_123",
        receivedAt: Date.now(),
        idempotencyKey: "idem_123",
        id: "evt_123",
        slug: "usage.recorded",
        timestamp: Date.UTC(2026, 2, 19),
        properties: { amount: 1 },
      },
    })

    expect(result).toMatchObject({
      allowed: false,
      rejectionReason: "INVALID_ENTITLEMENT_CONFIGURATION",
      state: "rejected",
    })
    expect(getEntitlementWindowStub).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      "multiple active entitlements matched ingestion event",
      expect.objectContaining({
        customerEntitlementIds: ["ce_123", "ce_duplicate"],
      })
    )
  })

  it("records late closed-period DO denials as rejected queue outcomes", async () => {
    const entitlement = createEntitlement()
    const apply = vi.fn().mockResolvedValue({
      allowed: false,
      deniedReason: "LATE_EVENT_CLOSED_PERIOD",
      message: "closed period",
    })
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply,
      getEnforcementState: vi.fn(),
    })
    const commit = vi.fn().mockResolvedValue({ inserted: 1, duplicates: 0, conflicts: 0 })

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never)),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      auditClient: {
        getAuditStub: vi.fn().mockReturnValue({
          commit,
          exists: vi.fn().mockResolvedValue([]),
        }),
      },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
      waitUntil: vi.fn(),
    })

    const result = await service.processCustomerGroup({
      customerId: entitlement.customerId,
      projectId: entitlement.projectId,
      messages: [
        {
          version: 1,
          projectId: entitlement.projectId,
          customerId: entitlement.customerId,
          requestId: "req_123",
          receivedAt: Date.now(),
          idempotencyKey: "idem_123",
          id: "evt_123",
          slug: "usage.recorded",
          timestamp: Date.UTC(2026, 2, 19),
          properties: { amount: 1 },
        },
      ],
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.disposition.action).toBe("ack")
    expect(commit).toHaveBeenCalledTimes(1)

    const [entries] = commit.mock.calls[0]!
    expect(entries[0]).toMatchObject({
      idempotencyKey: "idem_123",
      status: "rejected",
      rejectionReason: "LATE_EVENT_CLOSED_PERIOD",
    })
    expect(JSON.parse(entries[0].resultJson)).toEqual({
      state: "rejected",
      rejectionReason: "LATE_EVENT_CLOSED_PERIOD",
    })
  })

  it("rejects queue messages older than the ingestion cap before entitlement processing", async () => {
    const entitlement = createEntitlement()
    const getCustomerEntitlementsForCustomer = vi.fn()
    const getEntitlementWindowStub = vi.fn()
    const commit = vi.fn().mockResolvedValue({ inserted: 1, duplicates: 0, conflicts: 0 })
    const logger = createLogger()

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer,
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      auditClient: {
        getAuditStub: vi.fn().mockReturnValue({
          commit,
          exists: vi.fn().mockResolvedValue([]),
        }),
      },
      logger: logger as never,
      now: () => SERVICE_NOW,
      waitUntil: vi.fn(),
    })

    const result = await service.processCustomerGroup({
      customerId: entitlement.customerId,
      projectId: entitlement.projectId,
      messages: [
        {
          version: 1,
          projectId: entitlement.projectId,
          customerId: entitlement.customerId,
          requestId: "req_123",
          receivedAt: SERVICE_NOW - INGESTION_MAX_EVENT_AGE_MS - 10_000,
          idempotencyKey: "idem_too_old",
          id: "evt_too_old",
          slug: "usage.recorded",
          timestamp: SERVICE_NOW - INGESTION_MAX_EVENT_AGE_MS - 1,
          properties: { amount: 1 },
        },
      ],
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.disposition.action).toBe("ack")
    expect(getCustomerEntitlementsForCustomer).not.toHaveBeenCalled()
    expect(getEntitlementWindowStub).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      "raw ingestion event rejected as too old",
      expect.objectContaining({
        projectId: entitlement.projectId,
        customerId: entitlement.customerId,
        idempotencyKey: "idem_too_old",
        rejectionReason: "EVENT_TOO_OLD",
      })
    )
    expect(commit).toHaveBeenCalledTimes(1)

    const [entries] = commit.mock.calls[0]!
    expect(entries[0]).toMatchObject({
      idempotencyKey: "idem_too_old",
      status: "rejected",
      rejectionReason: "EVENT_TOO_OLD",
    })
  })
})

function createEntitlement(): IngestionEntitlement {
  return {
    customerEntitlementId: "ce_123",
    customerId: "cus_123",
    effectiveAt: Date.UTC(2026, 2, 1),
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
      eventId: "evt_type",
      eventSlug: "usage.recorded",
      aggregationMethod: "sum",
      aggregationField: "amount",
    },
    overageStrategy: "none",
    projectId: "proj_123",
    resetConfig: null,
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
    grants: [
      {
        id: `${entitlement.customerEntitlementId}_grant`,
        projectId: entitlement.projectId,
        customerEntitlementId: entitlement.customerEntitlementId,
        type: "subscription",
        priority: 10,
        allowanceUnits: 100,
        effectiveAt: entitlement.effectiveAt,
        expiresAt: entitlement.expiresAt,
        metadata: null,
        createdAtM: 0,
        updatedAtM: 0,
      },
    ],
    featurePlanVersion: {
      id: entitlement.featurePlanVersionId,
      projectId: entitlement.projectId,
      planVersionId: "version_123",
      type: "feature",
      featureId: "feature_123",
      featureType: "usage",
      unitOfMeasure: "units",
      config: entitlement.featureConfig,
      billingConfig: {
        name: "monthly",
        billingInterval: "month",
        billingIntervalCount: 1,
        billingAnchor: "dayOfCreation",
        planType: "recurring",
      },
      resetConfig: null,
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
        type: "usage",
        title: "API calls",
        description: null,
        metadata: null,
        createdAtM: 0,
        updatedAtM: 0,
      },
    },
  }
}

function createCache() {
  return {
    ingestionPreparedGrantContext: {
      swr: async (_key: string, loader: () => Promise<unknown>) => ({ val: await loader() }),
    },
  } as never
}

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    set: vi.fn(),
    warn: vi.fn(),
  }
}
