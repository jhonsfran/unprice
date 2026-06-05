import type { AnalyticsEntitlementMeterFact } from "@unprice/analytics"
import { EVENTS_SCHEMA_VERSION, type IngestionOutcome } from "./interface"
import type { IngestionQueueMessage } from "./message"
import {
  type IngestionReportingAuditRecord,
  type IngestionReportingEnvelope,
  computeCanonicalAuditId,
  computePayloadHash,
} from "./reporting"

export type IngestionReportingOutcome = {
  meterFacts?: AnalyticsEntitlementMeterFact[]
  message: IngestionQueueMessage
  outcome: IngestionOutcome
}

export async function buildIngestionReportingEnvelope(params: {
  customerId: string
  now: () => number
  outcomes: IngestionReportingOutcome[]
  projectId: string
}): Promise<IngestionReportingEnvelope> {
  const { customerId, now, outcomes, projectId } = params
  const [auditRecords, envelopeId] = await Promise.all([
    Promise.all(
      outcomes.map(({ message, outcome }) =>
        buildIngestionReportingAuditRecord({
          customerId,
          message,
          now,
          outcome,
          projectId,
        })
      )
    ),
    buildReportingEnvelopeId(projectId, customerId, outcomes),
  ])

  return {
    kind: "ingestion.reporting.v1",
    envelopeId,
    createdAt: now(),
    projectId,
    customerId,
    auditRecords,
    meterFacts: outcomes.flatMap((outcome) => outcome.meterFacts ?? []),
  }
}

export async function buildIngestionReportingAuditRecord(params: {
  customerId: string
  message: IngestionQueueMessage
  now: () => number
  outcome: IngestionOutcome
  projectId: string
}): Promise<IngestionReportingAuditRecord> {
  const { customerId, message, now, outcome, projectId } = params
  const handledAt = now()
  const [canonicalAuditId, payloadHash] = await Promise.all([
    computeCanonicalAuditId(projectId, customerId, message.idempotencyKey),
    computePayloadHash(message),
  ])

  return {
    idempotencyKey: message.idempotencyKey,
    canonicalAuditId,
    payloadHash,
    projectId,
    customerId,
    status: outcome.state,
    rejectionReason: outcome.rejectionReason,
    auditPayloadJson: JSON.stringify(
      buildIngestionAuditPayload(message, outcome, canonicalAuditId, payloadHash, handledAt)
    ),
    firstSeenAt: message.receivedAt,
    handledAt,
  }
}

export function buildIngestionAuditPayload(
  message: IngestionQueueMessage,
  outcome: IngestionOutcome,
  canonicalAuditId: string,
  payloadHash: string,
  handledAt: number
): Record<string, unknown> {
  return {
    event_date: toEventDate(message.timestamp),
    schema_version: EVENTS_SCHEMA_VERSION,
    id: message.id,
    project_id: message.projectId,
    customer_id: message.customerId,
    request_id: message.requestId,
    idempotency_key: message.idempotencyKey,
    slug: message.slug,
    timestamp: message.timestamp,
    received_at: message.receivedAt,
    handled_at: handledAt,
    state: outcome.state,
    rejection_reason: outcome.rejectionReason,
    properties: message.properties,
    canonical_audit_id: canonicalAuditId,
    payload_hash: payloadHash,
  }
}

async function buildReportingEnvelopeId(
  projectId: string,
  customerId: string,
  outcomes: IngestionReportingOutcome[]
): Promise<string> {
  const idempotencyKey = outcomes
    .map(({ message }) => `${message.idempotencyKey}:${message.id}`)
    .join("|")

  return computeCanonicalAuditId(projectId, customerId, idempotencyKey)
}

function toEventDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}
