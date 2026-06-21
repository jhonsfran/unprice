import type { AnalyticsEntitlementMeterFact } from "@unprice/analytics"
import { describe, expect, it } from "vitest"
import { type IngestionQueueMessage, ingestionQueueMessageSchema } from "./message"
import {
  buildIngestionReportingAuditRecord,
  buildIngestionReportingEnvelope,
} from "./reporting-envelope"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)
const HANDLED_AT = TEST_NOW + 123

describe("ingestion reporting envelope builder", () => {
  it("builds deterministic audit and envelope identities for the same outcomes", async () => {
    const message = createMessage()
    const outcome = { state: "processed" as const }

    const first = await buildIngestionReportingEnvelope({
      customerId: message.customerId,
      now: () => HANDLED_AT,
      outcomes: [{ message, outcome }],
      projectId: message.projectId,
    })
    const second = await buildIngestionReportingEnvelope({
      customerId: message.customerId,
      now: () => HANDLED_AT,
      outcomes: [{ message, outcome }],
      projectId: message.projectId,
    })

    expect(first.envelopeId).toBe(second.envelopeId)
    expect(first.auditRecords[0]?.canonicalAuditId).toBe(second.auditRecords[0]?.canonicalAuditId)
    expect(first.auditRecords[0]?.payloadHash).toBe(second.auditRecords[0]?.payloadHash)
    expect(first.auditRecords[0]?.canonicalAuditId).toHaveLength(64)
    expect(first.envelopeId).toHaveLength(64)
  })

  it("keeps payload hashes stable when property order changes", async () => {
    const baseMessage = createMessage({
      properties: { beta: 2, alpha: 1 },
    })
    const reorderedMessage = createMessage({
      properties: { alpha: 1, beta: 2 },
    })

    const [first, second] = await Promise.all([
      buildIngestionReportingAuditRecord({
        customerId: baseMessage.customerId,
        message: baseMessage,
        now: () => HANDLED_AT,
        outcome: { state: "processed" },
        projectId: baseMessage.projectId,
      }),
      buildIngestionReportingAuditRecord({
        customerId: reorderedMessage.customerId,
        message: reorderedMessage,
        now: () => HANDLED_AT,
        outcome: { state: "processed" },
        projectId: reorderedMessage.projectId,
      }),
    ])

    expect(first.payloadHash).toBe(second.payloadHash)
  })

  it("serializes rejected audit payloads with rejection reason and event metadata", async () => {
    const message = createMessage({
      id: "evt_rejected",
      timestamp: Date.UTC(2026, 2, 19, 23, 59, 59),
    })
    const record = await buildIngestionReportingAuditRecord({
      customerId: message.customerId,
      message,
      now: () => HANDLED_AT,
      outcome: { state: "rejected", rejectionReason: "WALLET_EMPTY" },
      projectId: message.projectId,
    })

    expect(record).toMatchObject({
      handledAt: HANDLED_AT,
      firstSeenAt: message.receivedAt,
      idempotencyKey: message.idempotencyKey,
      workspaceId: message.workspaceId,
      environment: "test",
      apiKeyId: "key_123",
      sourceType: "api_key",
      sourceId: "key_123",
      sourceName: null,
      rejectionReason: "WALLET_EMPTY",
      failureStage: null,
      failureReason: null,
      failureMessage: null,
      replayable: false,
      payloadJson: null,
      status: "rejected",
    })
    expect(JSON.parse(record.auditPayloadJson)).toMatchObject({
      event_date: "2026-03-19",
      id: "evt_rejected",
      workspace_id: message.workspaceId,
      project_id: message.projectId,
      customer_id: message.customerId,
      environment: "test",
      api_key_id: "key_123",
      source_type: "api_key",
      source_id: "key_123",
      source_name: null,
      state: "rejected",
      rejection_reason: "WALLET_EMPTY",
      canonical_audit_id: record.canonicalAuditId,
      payload_hash: record.payloadHash,
    })
    const rejectedPayload = JSON.parse(record.auditPayloadJson)
    expect(rejectedPayload).not.toHaveProperty("failure_stage")
    expect(rejectedPayload).not.toHaveProperty("failure_reason")
    expect(rejectedPayload).not.toHaveProperty("failure_message")
    expect(rejectedPayload).not.toHaveProperty("replayable")
    expect(rejectedPayload).not.toHaveProperty("payload_json")
  })

  it("includes payload_json only for failed reporting audit records", async () => {
    const message = createMessage()

    const [processedRecord, rejectedRecord, failedRecord] = await Promise.all([
      buildIngestionReportingAuditRecord({
        customerId: message.customerId,
        message,
        now: () => HANDLED_AT,
        outcome: { state: "processed" },
        projectId: message.projectId,
      }),
      buildIngestionReportingAuditRecord({
        customerId: message.customerId,
        message,
        now: () => HANDLED_AT,
        outcome: { state: "rejected", rejectionReason: "WALLET_EMPTY" },
        projectId: message.projectId,
      }),
      buildIngestionReportingAuditRecord({
        customerId: message.customerId,
        message,
        now: () => HANDLED_AT,
        outcome: {
          state: "failed",
          failureStage: "rating_fact",
          failureReason: "raw_ingestion_queue_processing_failed",
          failureMessage: "apply failed",
          replayable: true,
        },
        projectId: message.projectId,
      }),
    ])

    expect(processedRecord.payloadJson).toBeNull()
    expect(processedRecord).toMatchObject({
      status: "processed",
      failureStage: null,
      failureReason: null,
      failureMessage: null,
      replayable: false,
      payloadJson: null,
    })
    expect(JSON.parse(processedRecord.auditPayloadJson)).toMatchObject({
      state: "processed",
    })
    const processedPayload = JSON.parse(processedRecord.auditPayloadJson)
    expect(processedPayload).not.toHaveProperty("failure_stage")
    expect(processedPayload).not.toHaveProperty("failure_reason")
    expect(processedPayload).not.toHaveProperty("failure_message")
    expect(processedPayload).not.toHaveProperty("replayable")
    expect(processedPayload).not.toHaveProperty("payload_json")
    expect(rejectedRecord.payloadJson).toBeNull()
    expect(rejectedRecord).toMatchObject({
      status: "rejected",
      failureStage: null,
      failureReason: null,
      failureMessage: null,
      replayable: false,
      payloadJson: null,
    })
    expect(JSON.parse(rejectedRecord.auditPayloadJson)).toMatchObject({
      state: "rejected",
      rejection_reason: "WALLET_EMPTY",
    })
    const rejectedPayload2 = JSON.parse(rejectedRecord.auditPayloadJson)
    expect(rejectedPayload2).not.toHaveProperty("failure_stage")
    expect(rejectedPayload2).not.toHaveProperty("failure_reason")
    expect(rejectedPayload2).not.toHaveProperty("failure_message")
    expect(rejectedPayload2).not.toHaveProperty("replayable")
    expect(rejectedPayload2).not.toHaveProperty("payload_json")

    expect(failedRecord).toMatchObject({
      status: "failed",
      failureStage: "rating_fact",
      failureReason: "raw_ingestion_queue_processing_failed",
      failureMessage: "apply failed",
      replayable: true,
      payloadJson: JSON.stringify(message),
    })
    expect(ingestionQueueMessageSchema.parse(JSON.parse(failedRecord.payloadJson ?? ""))).toEqual(
      message
    )
    const failedAuditPayload = JSON.parse(failedRecord.auditPayloadJson)
    expect(failedAuditPayload).not.toHaveProperty("rejection_reason")
    expect(failedAuditPayload).toMatchObject({
      state: "failed",
    })
    expect(failedAuditPayload).not.toHaveProperty("failure_stage")
    expect(failedAuditPayload).not.toHaveProperty("failure_reason")
    expect(failedAuditPayload).not.toHaveProperty("failure_message")
    expect(failedAuditPayload).not.toHaveProperty("replayable")
    expect(failedAuditPayload).not.toHaveProperty("payload_json")
  })

  it("copies run context into reporting audit records without making processed rows replayable", async () => {
    const message = createMessage({
      runContext: {
        runId: "brun_001",
        traceId: "trace_001",
        parentRunId: "brun_parent_001",
        workloadType: "agent",
        workloadId: "research-assistant",
      },
    })

    const record = await buildIngestionReportingAuditRecord({
      customerId: "cus_1",
      message,
      now: () => 4070908801100,
      outcome: { state: "processed" },
      projectId: "proj_1",
    })

    expect(record).toMatchObject({
      runId: "brun_001",
      traceId: "trace_001",
      parentRunId: "brun_parent_001",
      workloadType: "agent",
      workloadId: "research-assistant",
      replayable: false,
      payloadJson: null,
    })
    expect(JSON.parse(record.auditPayloadJson)).toMatchObject({
      run_id: "brun_001",
      trace_id: "trace_001",
      parent_run_id: "brun_parent_001",
      workload_type: "agent",
      workload_id: "research-assistant",
    })
  })

  it("copies run context into rejected audit payloads without replay payloads", async () => {
    const message = createMessage({
      runContext: {
        runId: "brun_rejected_001",
        traceId: "trace_rejected_001",
        parentRunId: "brun_parent_rejected_001",
        workloadType: "workflow",
        workloadId: "billing-audit",
      },
    })

    const record = await buildIngestionReportingAuditRecord({
      customerId: message.customerId,
      message,
      now: () => HANDLED_AT,
      outcome: { state: "rejected", rejectionReason: "WALLET_EMPTY" },
      projectId: message.projectId,
    })

    expect(record).toMatchObject({
      payloadJson: null,
      replayable: false,
      status: "rejected",
    })
    expect(JSON.parse(record.auditPayloadJson)).toMatchObject({
      run_id: "brun_rejected_001",
      trace_id: "trace_rejected_001",
      parent_run_id: "brun_parent_rejected_001",
      workload_type: "workflow",
      workload_id: "billing-audit",
    })
  })

  it("carries meter facts from outcomes into the reporting envelope", async () => {
    const message = createMessage()
    const fact = createMeterFact({ event_id: message.id })

    const envelope = await buildIngestionReportingEnvelope({
      customerId: message.customerId,
      now: () => HANDLED_AT,
      outcomes: [{ message, outcome: { state: "processed" }, meterFacts: [fact] }],
      projectId: message.projectId,
    })

    expect(envelope).toMatchObject({
      createdAt: HANDLED_AT,
      customerId: message.customerId,
      projectId: message.projectId,
    })
    expect(envelope.auditRecords).toHaveLength(1)
    expect(envelope.meterFacts).toEqual([fact])
  })
})

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
