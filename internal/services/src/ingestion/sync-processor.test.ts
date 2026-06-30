import { describe, expect, it, vi } from "vitest"
import { INGESTION_MAX_EVENT_AGE_MS } from "../entitlements"
import type { IngestionEntitlement } from "./entitlement-context"
import { IngestionEntitlementRouter } from "./entitlement-routing"
import type { EntitlementWindowApplier } from "./entitlement-window-applier"
import type { IngestionQueueMessage } from "./message"
import { IngestionMessageOutcomes } from "./message-outcomes"
import { IngestionSyncProcessor } from "./sync-processor"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("IngestionSyncProcessor", () => {
  it("rejects stale events before loading entitlement context", async () => {
    const prepareCustomerGrantContext = vi.fn()
    const apply = vi.fn()
    const enqueueOutcomes = vi.fn().mockResolvedValue(undefined)
    const processor = createProcessor({
      apply,
      enqueueOutcomes,
      prepareCustomerGrantContext,
    })
    const message = createMessage({
      timestamp: TEST_NOW - INGESTION_MAX_EVENT_AGE_MS - 1,
    })

    const result = await processor.ingestFeatureSync({
      featureSlug: "api_calls",
      message,
    })

    expect(result).toEqual({
      allowed: false,
      message: "Event timestamp is older than the maximum accepted age",
      rejectionReason: "EVENT_TOO_OLD",
      state: "rejected",
    })
    expect(prepareCustomerGrantContext).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(enqueueOutcomes).toHaveBeenCalledWith({
      customerId: message.customerId,
      projectId: message.projectId,
      outcomes: [
        {
          message,
          outcome: {
            state: "rejected",
            rejectionReason: "EVENT_TOO_OLD",
          },
        },
      ],
    })
  })

  it("applies a matching entitlement and reports the processed outcome", async () => {
    const entitlement = createEntitlement()
    const apply = vi.fn().mockResolvedValue({
      allowed: true,
    })
    const enqueueOutcomes = vi.fn().mockResolvedValue(undefined)
    const prepareCustomerGrantContext = vi.fn().mockResolvedValue({
      candidateEntitlements: [entitlement],
    })
    const processor = createProcessor({
      apply,
      enqueueOutcomes,
      prepareCustomerGrantContext,
    })
    const message = createMessage()

    const result = await processor.ingestFeatureSync({
      featureSlug: entitlement.featureSlug,
      message,
    })

    expect(result).toEqual({
      allowed: true,
      state: "processed",
    })
    expect(prepareCustomerGrantContext).toHaveBeenCalledWith({
      customerId: message.customerId,
      projectId: message.projectId,
      startAt: Math.max(0, message.timestamp - INGESTION_MAX_EVENT_AGE_MS),
      endAt: message.timestamp,
    })
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: message.customerId,
        enforceLimit: true,
        entitlement,
        message,
        projectId: message.projectId,
      })
    )
    expect(enqueueOutcomes).toHaveBeenCalledWith({
      customerId: message.customerId,
      projectId: message.projectId,
      outcomes: [
        {
          message,
          outcome: { state: "processed" },
          meterFacts: undefined,
        },
      ],
    })
  })

  it("reports entitlement-window denials as rejected sync results", async () => {
    const entitlement = createEntitlement()
    const apply = vi.fn().mockResolvedValue({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
      message: "wallet empty",
    })
    const enqueueOutcomes = vi.fn().mockResolvedValue(undefined)
    const processor = createProcessor({
      apply,
      enqueueOutcomes,
      preparedContext: {
        candidateEntitlements: [entitlement],
      },
    })
    const message = createMessage()

    const result = await processor.ingestFeatureSync({
      featureSlug: entitlement.featureSlug,
      message,
    })

    expect(result).toEqual({
      allowed: false,
      message: "wallet empty",
      rejectionReason: "WALLET_EMPTY",
      state: "rejected",
    })
    expect(enqueueOutcomes).toHaveBeenCalledWith({
      customerId: message.customerId,
      projectId: message.projectId,
      outcomes: [
        {
          message,
          outcome: {
            state: "rejected",
            rejectionReason: "WALLET_EMPTY",
          },
        },
      ],
    })
  })

  it("runs subscription catch-up and retries WALLET_EMPTY sync denials", async () => {
    const beforeCatchUp = createEntitlement({
      customerEntitlementId: "ce_before",
      subscriptionId: "sub_123",
    })
    const afterCatchUp = createEntitlement({
      customerEntitlementId: "ce_after",
      subscriptionId: "sub_123",
    })
    const apply = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: false,
        deniedReason: "WALLET_EMPTY",
        message: "wallet empty",
      })
      .mockResolvedValueOnce({
        allowed: true,
        meterFacts: [],
      })
    const enqueueOutcomes = vi.fn().mockResolvedValue(undefined)
    const prepareCustomerGrantContext = vi
      .fn()
      .mockResolvedValueOnce({ candidateEntitlements: [beforeCatchUp] })
      .mockResolvedValueOnce({ candidateEntitlements: [afterCatchUp] })
    const catchUpForPreparedGroup = vi.fn().mockResolvedValue({
      changed: true,
      caughtUpSubscriptionIds: ["sub_123"],
    })
    const processor = createProcessor({
      apply,
      enqueueOutcomes,
      prepareCustomerGrantContext,
      subscriptionCatchUp: { catchUpForPreparedGroup },
    })
    const message = createMessage()

    const result = await processor.ingestFeatureSync({
      featureSlug: beforeCatchUp.featureSlug,
      message,
    })

    expect(result).toEqual({
      allowed: true,
      state: "processed",
    })
    expect(catchUpForPreparedGroup).toHaveBeenCalledWith({
      candidateEntitlements: [beforeCatchUp],
      customerId: message.customerId,
      messages: [message],
      projectId: message.projectId,
    })
    expect(prepareCustomerGrantContext).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        entitlement: afterCatchUp,
      })
    )
    expect(enqueueOutcomes).toHaveBeenCalledTimes(1)
    expect(enqueueOutcomes).toHaveBeenCalledWith({
      customerId: message.customerId,
      projectId: message.projectId,
      outcomes: [
        {
          message,
          outcome: { state: "processed" },
          meterFacts: [],
        },
      ],
    })
  })

  it("propagates reporting enqueue failures after successful apply", async () => {
    const entitlement = createEntitlement()
    const apply = vi.fn().mockResolvedValue({ allowed: true })
    const processor = createProcessor({
      apply,
      enqueueOutcomes: vi.fn().mockRejectedValue(new Error("reporting unavailable")),
      preparedContext: {
        candidateEntitlements: [entitlement],
      },
    })

    await expect(
      processor.ingestFeatureSync({
        featureSlug: entitlement.featureSlug,
        message: createMessage(),
      })
    ).rejects.toThrow("reporting unavailable")
    expect(apply).toHaveBeenCalledTimes(1)
  })
})

function createProcessor(
  overrides: {
    apply?: ReturnType<typeof vi.fn>
    enqueueOutcomes?: ReturnType<typeof vi.fn>
    preparedContext?: {
      candidateEntitlements: IngestionEntitlement[]
      rejectionReason?: "CUSTOMER_NOT_FOUND" | "NO_MATCHING_ENTITLEMENT"
    }
    prepareCustomerGrantContext?: ReturnType<typeof vi.fn>
    subscriptionCatchUp?: {
      catchUpForPreparedGroup: ReturnType<typeof vi.fn>
    }
  } = {}
) {
  const logger = createLogger()
  const preparedContext = overrides.preparedContext ?? {
    candidateEntitlements: [createEntitlement()],
  }
  return new IngestionSyncProcessor({
    entitlementContext: {
      prepareCustomerGrantContext:
        overrides.prepareCustomerGrantContext ?? vi.fn().mockResolvedValue(preparedContext),
    },
    entitlementRouter: new IngestionEntitlementRouter({ logger }),
    entitlementWindowApplier: {
      apply: overrides.apply ?? vi.fn().mockResolvedValue({ allowed: true }),
    } as unknown as EntitlementWindowApplier,
    messageOutcomes: new IngestionMessageOutcomes({ logger, now: () => TEST_NOW }),
    now: () => TEST_NOW,
    reportingDispatcher: {
      enqueueOutcomes: overrides.enqueueOutcomes ?? vi.fn().mockResolvedValue(undefined),
    },
    subscriptionCatchUp: overrides.subscriptionCatchUp as never,
  })
}

function createLogger() {
  return {
    error: vi.fn(),
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
