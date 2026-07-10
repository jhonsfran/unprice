import type { AnalyticsEntitlementMeterFact } from "@unprice/analytics"
import { EVENTS_SCHEMA_VERSION, type IngestionOutcome } from "./interface"
import type { IngestionQueueMessage } from "./message"
import { serializeReplayPayload } from "./message-outcomes"
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
    redriveCount: 0,
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
  const failed = outcome.state === "failed"
  const runContext = getMessageRunContext(message)

  // Single outcome -> record projection. Everything the downstream row needs
  // (including replay payload, computed once) lives on the record; the
  // snake_case audit payload is derived from it rather than re-reading message.
  const record: Omit<IngestionReportingAuditRecord, "auditPayloadJson"> = {
    idempotencyKey: message.idempotencyKey,
    canonicalAuditId,
    payloadHash,
    workspaceId: message.workspaceId,
    projectId,
    customerId,
    environment: message.source.environment,
    apiKeyId: message.source.apiKeyId,
    sourceType: message.source.sourceType,
    sourceId: message.source.sourceId,
    sourceName: message.source.sourceName,
    runId: runContext.runId,
    traceId: runContext.traceId,
    parentRunId: runContext.parentRunId,
    workloadType: runContext.workloadType,
    workloadId: runContext.workloadId,
    ingestionMode: getMessageIngestionMode(message),
    eventId: message.id,
    slug: message.slug,
    timestamp: message.timestamp,
    status: outcome.state,
    rejectionReason: outcome.state === "rejected" ? outcome.rejectionReason : undefined,
    failureStage: failed ? outcome.failureStage : null,
    failureReason: failed ? outcome.failureReason : null,
    failureMessage: failed ? (outcome.failureMessage ?? null) : null,
    replayable: failed ? outcome.replayable : false,
    payloadJson: failed ? serializeReplayPayload(message) : null,
    firstSeenAt: message.receivedAt,
    handledAt,
  }

  return {
    ...record,
    auditPayloadJson: JSON.stringify(buildIngestionAuditPayload(record, message)),
  }
}

export function buildIngestionAuditPayload(
  record: Omit<IngestionReportingAuditRecord, "auditPayloadJson">,
  message: Pick<IngestionQueueMessage, "properties" | "requestId">
): Record<string, unknown> {
  return {
    event_date: toEventDate(record.timestamp),
    schema_version: EVENTS_SCHEMA_VERSION,
    id: record.eventId,
    workspace_id: record.workspaceId,
    project_id: record.projectId,
    customer_id: record.customerId,
    environment: record.environment,
    api_key_id: record.apiKeyId,
    source_type: record.sourceType,
    source_id: record.sourceId,
    source_name: record.sourceName,
    run_id: record.runId,
    trace_id: record.traceId,
    parent_run_id: record.parentRunId,
    workload_type: record.workloadType,
    workload_id: record.workloadId,
    ingestion_mode: record.ingestionMode,
    request_id: message.requestId,
    idempotency_key: record.idempotencyKey,
    slug: record.slug,
    timestamp: record.timestamp,
    received_at: record.firstSeenAt,
    handled_at: record.handledAt,
    state: record.status,
    rejection_reason: record.status === "rejected" ? record.rejectionReason : undefined,
    failure_stage: record.failureStage,
    failure_reason: record.failureReason,
    failure_message: record.failureMessage,
    replayable: record.replayable,
    payload_json: record.payloadJson,
    properties: message.properties,
    canonical_audit_id: record.canonicalAuditId,
    payload_hash: record.payloadHash,
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

function getMessageRunContext(message: IngestionQueueMessage): {
  runId: string | null
  traceId: string | null
  parentRunId: string | null
  workloadType: "agent" | "workflow" | "job" | "tool" | "custom" | null
  workloadId: string | null
} {
  const runContext = message.runContext ?? null

  return {
    runId: runContext?.runId ?? null,
    traceId: runContext?.traceId ?? null,
    parentRunId: runContext?.parentRunId ?? null,
    workloadType: runContext?.workloadType ?? null,
    workloadId: runContext?.workloadId ?? null,
  }
}

function getMessageIngestionMode(message: IngestionQueueMessage): "async" | "sync" | "run" {
  if (message.runContext?.runId) {
    return "run"
  }

  return message.ingestionMode ?? "async"
}
