import { describe, expect, it, vi } from "vitest"
import type { IngestionEntitlement } from "./entitlement-context"
import {
  EntitlementWindowApplier,
  type EntitlementWindowClient,
  type EntitlementWindowController,
} from "./entitlement-window-applier"
import { buildMessageOutcomeKeys } from "./fanout-outcomes"
import type { IngestionQueueMessage } from "./message"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("EntitlementWindowApplier", () => {
  it("returns denied batch results without calling a window when meter config is missing", async () => {
    const getEntitlementWindowStub = vi.fn()
    const applier = new EntitlementWindowApplier({ getEntitlementWindowStub })
    const messages = [createMessage({ id: "evt_1" }), createMessage({ id: "evt_2" })]

    const results = await applier.applyBatch({
      customerId: "cus_123",
      enforceLimit: false,
      entitlement: createEntitlement({ meterConfig: null }),
      messageOutcomeKeys: buildMessageOutcomeKeys(messages),
      messages,
      projectId: "proj_123",
    })

    expect(getEntitlementWindowStub).not.toHaveBeenCalled()
    expect(results).toEqual([
      expect.objectContaining({
        allowed: false,
        deniedReason: "LIMIT_EXCEEDED",
        idempotencyKey: "idem_123",
        message: "Usage entitlement is missing meter configuration",
      }),
      expect.objectContaining({
        allowed: false,
        deniedReason: "LIMIT_EXCEEDED",
        idempotencyKey: "idem_123",
      }),
    ])
  })

  it("falls back to sequential apply when applyBatch is unavailable", async () => {
    const apply = vi.fn().mockResolvedValue({ allowed: true })
    const messages = [
      createMessage({ id: "evt_1", idempotencyKey: "idem_1" }),
      createMessage({ id: "evt_2", idempotencyKey: "idem_2" }),
    ]
    const applier = new EntitlementWindowApplier(createClient({ apply }))

    const results = await applier.applyBatch({
      customerId: "cus_123",
      enforceLimit: false,
      entitlement: createEntitlement(),
      messageOutcomeKeys: buildMessageOutcomeKeys(messages),
      messages,
      projectId: "proj_123",
    })

    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls.map(([input]) => input.event.id)).toEqual(["evt_1", "evt_2"])
    expect(results.map((result) => result.idempotencyKey)).toEqual(["idem_1", "idem_2"])
    expect(results.every((result) => result.allowed)).toBe(true)
  })

  it("maps out-of-order batch results back to the original message order", async () => {
    const messages = [
      createMessage({ id: "evt_1", idempotencyKey: "idem_1" }),
      createMessage({ id: "evt_2", idempotencyKey: "idem_2" }),
    ]
    const keys = buildMessageOutcomeKeys(messages)
    const applyBatch = vi.fn().mockResolvedValue({
      results: [...messages].reverse().map((message) => ({
        allowed: true,
        correlationKey: keys.get(message),
        idempotencyKey: message.idempotencyKey,
      })),
    })
    const applier = new EntitlementWindowApplier(createClient({ applyBatch }))

    const results = await applier.applyBatch({
      customerId: "cus_123",
      enforceLimit: false,
      entitlement: createEntitlement(),
      messageOutcomeKeys: keys,
      messages,
      projectId: "proj_123",
    })

    expect(applyBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({ id: "evt_1", idempotencyKey: "idem_1" }),
          expect.objectContaining({ id: "evt_2", idempotencyKey: "idem_2" }),
        ],
      })
    )
    expect(results.map((result) => result.idempotencyKey)).toEqual(["idem_1", "idem_2"])
  })

  it("throws when a batch result is missing for a message", async () => {
    const firstMessage = createMessage({ id: "evt_1", idempotencyKey: "idem_1" })
    const secondMessage = createMessage({ id: "evt_2", idempotencyKey: "idem_2" })
    const messages = [firstMessage, secondMessage]
    const keys = buildMessageOutcomeKeys(messages)
    const applyBatch = vi.fn().mockResolvedValue({
      results: [
        {
          allowed: true,
          correlationKey: keys.get(firstMessage),
          idempotencyKey: "idem_1",
        },
      ],
    })
    const applier = new EntitlementWindowApplier(createClient({ applyBatch }))

    await expect(
      applier.applyBatch({
        customerId: "cus_123",
        enforceLimit: false,
        entitlement: createEntitlement(),
        messageOutcomeKeys: keys,
        messages,
        projectId: "proj_123",
      })
    ).rejects.toThrow("entitlement window batch result missing message outcome")
  })

  it("throws when a batch result idempotency key does not match the message", async () => {
    const message = createMessage({ id: "evt_1", idempotencyKey: "idem_1" })
    const keys = buildMessageOutcomeKeys([message])
    const applyBatch = vi.fn().mockResolvedValue({
      results: [
        {
          allowed: true,
          correlationKey: keys.get(message),
          idempotencyKey: "wrong_idem",
        },
      ],
    })
    const applier = new EntitlementWindowApplier(createClient({ applyBatch }))

    await expect(
      applier.applyBatch({
        customerId: "cus_123",
        enforceLimit: false,
        entitlement: createEntitlement(),
        messageOutcomeKeys: keys,
        messages: [message],
        projectId: "proj_123",
      })
    ).rejects.toThrow("entitlement window batch result idempotency mismatch")
  })
})

function createClient(stub: Partial<EntitlementWindowController>): EntitlementWindowClient {
  return {
    getEntitlementWindowStub: vi.fn().mockReturnValue({
      apply: stub.apply ?? vi.fn().mockResolvedValue({ allowed: true }),
      getEnforcementState: vi.fn(),
      ...stub,
    }),
  }
}

function createMessage(overrides: Partial<IngestionQueueMessage> = {}): IngestionQueueMessage {
  return {
    version: 1,
    projectId: "proj_123",
    customerId: "cus_123",
    requestId: "req_123",
    receivedAt: TEST_NOW,
    idempotencyKey: "idem_123",
    id: "evt_123",
    slug: "usage.recorded",
    timestamp: TEST_NOW,
    properties: { amount: 1 },
    ...overrides,
  }
}

function createEntitlement(overrides: Partial<IngestionEntitlement> = {}): IngestionEntitlement {
  return {
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
    ...overrides,
  }
}
