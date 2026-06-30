import type { AnalyticsEntitlementMeterFact } from "@unprice/analytics"
import { describe, expect, it, vi } from "vitest"
import type { IngestionQueueMessage } from "./message"
import { IngestionReportingDispatcher } from "./reporting-dispatcher"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("IngestionReportingDispatcher", () => {
  it("does not send a reporting envelope when there are no outcomes", async () => {
    const send = vi.fn()
    const logger = createLogger()
    const dispatcher = new IngestionReportingDispatcher({
      logger,
      now: () => TEST_NOW,
      reportingClient: { send },
    })

    await dispatcher.enqueueOutcomes({
      customerId: "cus_123",
      outcomes: [],
      projectId: "proj_123",
    })

    expect(send).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("chunks large reporting envelopes before sending to the queue", async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const dispatcher = new IngestionReportingDispatcher({
      logger: createLogger(),
      now: () => TEST_NOW,
      reportingClient: { send },
    })

    await dispatcher.enqueueOutcomes({
      customerId: "cus_123",
      outcomes: [
        {
          message: createMessage({
            id: "evt_large_1",
            idempotencyKey: "idem_large_1",
            properties: { body: "x".repeat(70_000) },
          }),
          outcome: { state: "processed" },
        },
        {
          message: createMessage({
            id: "evt_large_2",
            idempotencyKey: "idem_large_2",
            properties: { body: "y".repeat(70_000) },
          }),
          outcome: { state: "processed" },
        },
      ],
      projectId: "proj_123",
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.map(([envelope]) => envelope.auditRecords.length)).toEqual([1, 1])
    expect(send.mock.calls.map(([envelope]) => envelope.envelopeId)).toEqual([
      expect.not.stringContaining(":"),
      expect.stringContaining(":2"),
    ])
  })

  it("logs and rethrows reporting enqueue failures with envelope counts", async () => {
    const error = new Error("queue down")
    const send = vi.fn().mockRejectedValue(error)
    const logger = createLogger()
    const message = createMessage()
    const meterFact = createMeterFact({ event_id: message.id })
    const dispatcher = new IngestionReportingDispatcher({
      logger,
      now: () => TEST_NOW,
      reportingClient: { send },
    })

    await expect(
      dispatcher.enqueueOutcomes({
        customerId: message.customerId,
        outcomes: [{ message, outcome: { state: "processed" }, meterFacts: [meterFact] }],
        projectId: message.projectId,
      })
    ).rejects.toThrow("queue down")

    expect(logger.error).toHaveBeenCalledWith("ingestion reporting enqueue failed", {
      projectId: message.projectId,
      customerId: message.customerId,
      reporting_envelope_count: 1,
      reporting_audit_record_count: 1,
      reporting_meter_fact_count: 1,
      reporting_enqueue_failure_count: 1,
      error,
    })
  })
})

function createLogger() {
  return {
    error: vi.fn(),
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

function createMeterFact(
  overrides: Partial<AnalyticsEntitlementMeterFact> = {}
): AnalyticsEntitlementMeterFact {
  return {
    event_id: "evt_123",
    idempotency_key: "idem_123",
    workspace_id: "ws_123",
    project_id: "proj_123",
    customer_id: "cus_123",
    environment: "test",
    api_key_id: "key_123",
    source_type: "api_key",
    source_id: "key_123",
    source_name: null,
    run_id: null,
    trace_id: null,
    parent_run_id: null,
    workload_type: null,
    workload_id: null,
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
    tier_index: null,
    tier_mode: null,
    pricing_component_count: 0,
    ...overrides,
  }
}
