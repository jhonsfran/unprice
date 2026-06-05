import type { AnalyticsEntitlementMeterFact } from "@unprice/analytics"
import { describe, expect, it } from "vitest"
import {
  AsyncFanoutOutcomeAccumulator,
  buildMessageOutcomeKeys,
  getMessageOutcomeKey,
} from "./fanout-outcomes"
import type { IngestionQueueMessage } from "./message"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

type TestEntitlement = {
  customerEntitlementId: string
}

describe("AsyncFanoutOutcomeAccumulator", () => {
  it("groups planned applies by customer entitlement and reports fanout stats", () => {
    const firstMessage = createMessage({ id: "evt_1", idempotencyKey: "idem_1" })
    const secondMessage = createMessage({ id: "evt_2", idempotencyKey: "idem_2" })
    const accumulator = new AsyncFanoutOutcomeAccumulator<TestEntitlement>(
      buildMessageOutcomeKeys([firstMessage, secondMessage])
    )

    accumulator.planEntitlementApplies(firstMessage, [
      createEntitlement("ce_tokens"),
      createEntitlement("ce_requests"),
    ])
    accumulator.planEntitlementApplies(secondMessage, [createEntitlement("ce_tokens")])

    expect(
      accumulator.getApplyGroups().map((group) => ({
        customerEntitlementId: group.entitlement.customerEntitlementId,
        eventIds: group.messages.map((message) => message.id),
      }))
    ).toEqual([
      { customerEntitlementId: "ce_tokens", eventIds: ["evt_1", "evt_2"] },
      { customerEntitlementId: "ce_requests", eventIds: ["evt_1"] },
    ])
    expect(accumulator.getFanoutStats()).toEqual({
      applyGroupCount: 2,
      matchedEntitlementCount: 3,
      matchedEntitlementsPerEventMax: 2,
    })
  })

  it("keeps a message processed when one fanout leg allows before another denies late", () => {
    const message = createMessage()
    const keys = buildMessageOutcomeKeys([message])
    const accumulator = new AsyncFanoutOutcomeAccumulator<TestEntitlement>(keys)
    const correlationKey = getMessageOutcomeKey(message, keys)
    const fact = createMeterFact({ event_id: message.id })

    accumulator.planEntitlementApplies(message, [
      createEntitlement("ce_tokens"),
      createEntitlement("ce_requests"),
    ])
    accumulator.recordApplyResult({
      allowed: true,
      correlationKey,
      meterFacts: [fact],
    })
    accumulator.recordApplyResult({
      allowed: false,
      correlationKey,
      deniedReason: "LATE_EVENT_CLOSED_PERIOD",
    })

    expect(accumulator.toMessageOutcomes([message])).toEqual([
      {
        message,
        meterFacts: [fact],
        outcome: { state: "processed" },
      },
    ])
  })

  it("rejects a message with the concrete denial when no fanout leg allows", () => {
    const message = createMessage()
    const keys = buildMessageOutcomeKeys([message])
    const accumulator = new AsyncFanoutOutcomeAccumulator<TestEntitlement>(keys)

    accumulator.planEntitlementApplies(message, [createEntitlement("ce_tokens")])
    accumulator.recordApplyResult({
      allowed: false,
      correlationKey: getMessageOutcomeKey(message, keys),
      deniedReason: "WALLET_EMPTY",
    })

    expect(accumulator.toMessageOutcomes([message])).toEqual([
      {
        message,
        meterFacts: undefined,
        outcome: { state: "rejected", rejectionReason: "WALLET_EMPTY" },
      },
    ])
  })

  it("rejects with late closed period when every planned fanout leg denies late", () => {
    const message = createMessage()
    const keys = buildMessageOutcomeKeys([message])
    const accumulator = new AsyncFanoutOutcomeAccumulator<TestEntitlement>(keys)
    const correlationKey = getMessageOutcomeKey(message, keys)

    accumulator.planEntitlementApplies(message, [
      createEntitlement("ce_tokens"),
      createEntitlement("ce_requests"),
    ])
    accumulator.recordApplyResult({
      allowed: false,
      correlationKey,
      deniedReason: "LATE_EVENT_CLOSED_PERIOD",
    })
    accumulator.recordApplyResult({
      allowed: false,
      correlationKey,
      deniedReason: "LATE_EVENT_CLOSED_PERIOD",
    })

    expect(accumulator.toMessageOutcomes([message])[0]?.outcome).toEqual({
      state: "rejected",
      rejectionReason: "LATE_EVENT_CLOSED_PERIOD",
    })
  })

  it("correlates messages that share an idempotency key by event position", () => {
    const firstMessage = createMessage({ id: "evt_first", idempotencyKey: "idem_shared" })
    const secondMessage = createMessage({ id: "evt_second", idempotencyKey: "idem_shared" })
    const keys = buildMessageOutcomeKeys([firstMessage, secondMessage])
    const accumulator = new AsyncFanoutOutcomeAccumulator<TestEntitlement>(keys)

    accumulator.planEntitlementApplies(firstMessage, [createEntitlement("ce_tokens")])
    accumulator.planEntitlementApplies(secondMessage, [createEntitlement("ce_tokens")])
    accumulator.recordApplyResult({
      allowed: true,
      correlationKey: getMessageOutcomeKey(firstMessage, keys),
    })
    accumulator.recordApplyResult({
      allowed: false,
      correlationKey: getMessageOutcomeKey(secondMessage, keys),
      deniedReason: "LATE_EVENT_CLOSED_PERIOD",
    })

    expect(
      accumulator.toMessageOutcomes([firstMessage, secondMessage]).map(({ message, outcome }) => ({
        eventId: message.id,
        outcome,
      }))
    ).toEqual([
      { eventId: "evt_first", outcome: { state: "processed" } },
      {
        eventId: "evt_second",
        outcome: { state: "rejected", rejectionReason: "LATE_EVENT_CLOSED_PERIOD" },
      },
    ])
  })
})

function createEntitlement(customerEntitlementId: string): TestEntitlement {
  return { customerEntitlementId }
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

function createMeterFact(
  overrides: Partial<AnalyticsEntitlementMeterFact> = {}
): AnalyticsEntitlementMeterFact {
  return {
    event_id: "evt_123",
    idempotency_key: "idem_123",
    project_id: "proj_123",
    customer_id: "cus_123",
    customer_entitlement_id: "ce_123",
    feature_slug: "api_calls",
    period_key: "2026-03",
    event_slug: "usage.recorded",
    aggregation_method: "sum",
    timestamp: TEST_NOW,
    created_at: TEST_NOW + 1,
    delta: 1,
    value_after: 1,
    grant_id: "grant_123",
    feature_plan_version_id: "fpv_123",
    amount: 0,
    amount_after: 0,
    amount_scale: 8,
    currency: "USD",
    priced_at: TEST_NOW + 1,
    ...overrides,
  }
}
