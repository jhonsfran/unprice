import type { Subscription } from "@unprice/db/validators"
import { describe, expect, it, vi } from "vitest"
import type { IngestionEntitlement } from "./entitlement-context"
import type { IngestionQueueMessage } from "./message"
import {
  IngestionSubscriptionCatchUp,
  type IngestionSubscriptionCatchUpService,
} from "./subscription-catchup"

const TEST_NOW = Date.UTC(2026, 5, 12, 13, 49, 10)

describe("IngestionSubscriptionCatchUp", () => {
  it("renews a subscription-backed usage entitlement when no billing period covers the event", async () => {
    const renewSubscription = vi.fn().mockResolvedValue({ val: { status: "active" } })
    const getSubscriptionData = vi.fn().mockResolvedValue(
      createSubscription({
        currentCycleEndAt: TEST_NOW - 1_000,
        renewAt: TEST_NOW - 1_000,
      })
    )
    const catchUp = createCatchUp({ getSubscriptionData, renewSubscription })

    const result = await catchUp.catchUpForPreparedGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [createMessage()],
      candidateEntitlements: [
        createEntitlement({
          subscriptionId: "sub_123",
          billingPeriods: [],
        }),
      ],
    })

    expect(result).toEqual({
      changed: true,
      renewedSubscriptionIds: ["sub_123"],
    })
    expect(getSubscriptionData).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      projectId: "proj_123",
    })
    expect(renewSubscription).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      projectId: "proj_123",
      now: TEST_NOW,
    })
  })

  it("does not load subscriptions when a billing period already covers the event", async () => {
    const getSubscriptionData = vi.fn()
    const renewSubscription = vi.fn()
    const activateWallet = vi.fn()
    const catchUp = createCatchUp({ activateWallet, getSubscriptionData, renewSubscription })

    const result = await catchUp.catchUpForPreparedGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [createMessage()],
      candidateEntitlements: [
        createEntitlement({
          subscriptionId: "sub_123",
          billingPeriods: [
            {
              billingPeriodId: "bp_123",
              cycleStartAt: TEST_NOW - 1_000,
              cycleEndAt: TEST_NOW + 1_000,
              featurePlanVersionItemId: "si_123",
              statementKey: "sub_123:2026-06",
            },
          ],
        }),
      ],
    })

    expect(result).toEqual({
      changed: false,
      renewedSubscriptionIds: [],
    })
    expect(getSubscriptionData).not.toHaveBeenCalled()
    expect(renewSubscription).not.toHaveBeenCalled()
    expect(activateWallet).not.toHaveBeenCalled()
  })

  it("activates subscriptions parked in pending_activation before fanout", async () => {
    const activateWallet = vi.fn().mockResolvedValue({ val: { status: "active" } })
    const renewSubscription = vi.fn()
    const getSubscriptionData = vi.fn().mockResolvedValue(
      createSubscription({
        status: "pending_activation",
        currentCycleEndAt: TEST_NOW + 60_000,
        renewAt: TEST_NOW + 60_000,
      })
    )
    const catchUp = createCatchUp({ activateWallet, getSubscriptionData, renewSubscription })

    const result = await catchUp.catchUpForPreparedGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [createMessage()],
      candidateEntitlements: [createEntitlement({ subscriptionId: "sub_123" })],
    })

    expect(result).toEqual({
      changed: true,
      renewedSubscriptionIds: ["sub_123"],
    })
    expect(activateWallet).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      projectId: "proj_123",
      now: TEST_NOW,
    })
    expect(renewSubscription).not.toHaveBeenCalled()
  })

  it("propagates subscription lock failures so the queue message can retry", async () => {
    const catchUp = createCatchUp({
      getSubscriptionData: vi.fn().mockResolvedValue(
        createSubscription({
          currentCycleEndAt: TEST_NOW - 1_000,
          renewAt: TEST_NOW - 1_000,
        })
      ),
      renewSubscription: vi.fn().mockResolvedValue({ err: new Error("SUBSCRIPTION_BUSY") }),
    })

    await expect(
      catchUp.catchUpForPreparedGroup({
        customerId: "cus_123",
        projectId: "proj_123",
        messages: [createMessage()],
        candidateEntitlements: [createEntitlement({ subscriptionId: "sub_123" })],
      })
    ).rejects.toThrow("SUBSCRIPTION_BUSY")
  })

  it("treats pending activation after renewal as retryable instead of continuing to fanout", async () => {
    const catchUp = createCatchUp({
      getSubscriptionData: vi.fn().mockResolvedValue(
        createSubscription({
          currentCycleEndAt: TEST_NOW - 1_000,
          renewAt: TEST_NOW - 1_000,
        })
      ),
      renewSubscription: vi.fn().mockResolvedValue({ val: { status: "pending_activation" } }),
    })

    await expect(
      catchUp.catchUpForPreparedGroup({
        customerId: "cus_123",
        projectId: "proj_123",
        messages: [createMessage()],
        candidateEntitlements: [createEntitlement({ subscriptionId: "sub_123" })],
      })
    ).rejects.toThrow("Subscription catch-up did not return active status")
  })
})

function createCatchUp(overrides: {
  activateWallet?: ReturnType<typeof vi.fn>
  getSubscriptionData: ReturnType<typeof vi.fn>
  renewSubscription: ReturnType<typeof vi.fn>
}) {
  return new IngestionSubscriptionCatchUp({
    logger: { info: vi.fn() },
    subscriptions: {
      activateWallet: overrides.activateWallet ?? vi.fn(),
      getSubscriptionData: overrides.getSubscriptionData,
      renewSubscription: overrides.renewSubscription,
    } as unknown as IngestionSubscriptionCatchUpService,
  })
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
    subscriptionId: "sub_123",
    subscriptionItemId: "si_123",
    ...overrides,
  }
}

function createSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub_123",
    projectId: "proj_123",
    customerId: "cus_123",
    active: true,
    status: "active",
    currentCycleEndAt: TEST_NOW - 1_000,
    renewAt: TEST_NOW - 1_000,
    ...overrides,
  } as Subscription
}
