import type { AnalyticsEntitlementMeterFact } from "@unprice/analytics"
import { describe, expect, it } from "vitest"
import type { IngestionQueueMessage } from "./message"
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
      rejectionReason: "WALLET_EMPTY",
      status: "rejected",
    })
    expect(JSON.parse(record.auditPayloadJson)).toMatchObject({
      event_date: "2026-03-19",
      id: "evt_rejected",
      project_id: message.projectId,
      customer_id: message.customerId,
      state: "rejected",
      rejection_reason: "WALLET_EMPTY",
      canonical_audit_id: record.canonicalAuditId,
      payload_hash: record.payloadHash,
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
