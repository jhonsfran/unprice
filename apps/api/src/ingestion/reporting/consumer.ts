import { Analytics, type AnalyticsIngestionEvent, ingestionEventSchemaV1 } from "@unprice/analytics"
import type { Logger } from "@unprice/logs"
import { createStandaloneRequestLogger } from "@unprice/observability"
import {
  type IngestionReportingEnvelope,
  ingestionReportingEnvelopeSchema,
} from "@unprice/services/ingestion"
import { z } from "zod"
import type { Env } from "~/env"
import { type AuditRecordPublisher, createAuditRecordPublisher } from "./audit-record-publisher"
import {
  type MeterFactIngest,
  chunkMeterFactsForTinybird,
  publishMeterFactChunks,
} from "./tinybird-meter-facts"

export { chunkMeterFactsForTinybird } from "./tinybird-meter-facts"

const TINYBIRD_MAX_INGESTION_EVENTS_PER_REQUEST = 5_000
const TINYBIRD_MAX_INGESTION_EVENT_NDJSON_BYTES_PER_REQUEST = 5 * 1024 * 1024
const textEncoder = new TextEncoder()

const auditPayloadForIngestionEventSchema = z.object({
  id: z.string(),
  slug: z.string(),
  timestamp: z.number().int(),
})

export type IngestionReportingQueueBatchMessage = {
  ack: () => void
  body: IngestionReportingEnvelope
  retry: (options?: { delaySeconds?: number }) => void
}

export type IngestionReportingQueueBatch = {
  messages: readonly IngestionReportingQueueBatchMessage[]
}

type IngestionEventIngest = (
  events: AnalyticsIngestionEvent[]
) => Promise<{ quarantined_rows?: number; successful_rows?: number } | undefined>

export class IngestionReportingConsumer {
  private readonly logger: Logger
  private readonly publishAuditRecords: AuditRecordPublisher
  private readonly ingestIngestionEvents: IngestionEventIngest
  private readonly ingestMeterFacts: MeterFactIngest

  constructor(opts: {
    ingestIngestionEvents: IngestionEventIngest
    ingestMeterFacts: MeterFactIngest
    logger: Logger
    publishAuditRecords: AuditRecordPublisher
  }) {
    this.ingestIngestionEvents = opts.ingestIngestionEvents
    this.ingestMeterFacts = opts.ingestMeterFacts
    this.logger = opts.logger
    this.publishAuditRecords = opts.publishAuditRecords
  }

  public async consumeBatch(batch: IngestionReportingQueueBatch): Promise<void> {
    const envelopes = batch.messages.map((message) =>
      ingestionReportingEnvelopeSchema.parse(message.body)
    )

    const auditRecords = envelopes.flatMap((envelope) => envelope.auditRecords)
    const meterFacts = envelopes.flatMap((envelope) => envelope.meterFacts)
    const tinybirdChunks = chunkMeterFactsForTinybird(meterFacts)
    const ingestionEvents = auditRecords.map((record) => buildIngestionEvent(record))
    const ingestionEventChunks = chunkIngestionEventsForTinybird(ingestionEvents)
    const pipelineSendCount = auditRecords.length > 0 ? 1 : 0

    await this.publishAuditRecords(auditRecords)
    await publishMeterFactChunks(tinybirdChunks, this.ingestMeterFacts)
    await publishIngestionEventChunks(ingestionEventChunks, this.ingestIngestionEvents)

    for (const message of batch.messages) {
      message.ack()
    }

    this.logger.info("ingestion reporting queue batch", {
      reporting_envelope_count: envelopes.length,
      reporting_audit_record_count: auditRecords.length,
      reporting_meter_fact_count: meterFacts.length,
      reporting_pipeline_record_count: auditRecords.length,
      reporting_tinybird_request_count: tinybirdChunks.length,
      reporting_ingestion_status_tinybird_request_count: ingestionEventChunks.length,
      meter_facts_per_tinybird_request:
        tinybirdChunks.length > 0 ? meterFacts.length / tinybirdChunks.length : 0,
      pipeline_records_per_pipeline_send:
        pipelineSendCount > 0 ? auditRecords.length / pipelineSendCount : 0,
    })
  }
}

export function createIngestionReportingConsumer(params: {
  env: Pick<
    Env,
    "APP_ENV" | "LOCAL_PIPELINE_URL" | "PIPELINE_EVENTS" | "TINYBIRD_TOKEN" | "TINYBIRD_URL"
  >
  logger: Logger
}): IngestionReportingConsumer {
  const analytics = new Analytics({
    emit: true,
    tinybirdToken: params.env.TINYBIRD_TOKEN,
    tinybirdUrl: params.env.TINYBIRD_URL,
    logger: params.logger,
  })

  return new IngestionReportingConsumer({
    ingestIngestionEvents: analytics.ingestIngestionEvents,
    ingestMeterFacts: analytics.ingestEntitlementMeterFacts,
    logger: params.logger,
    publishAuditRecords: createAuditRecordPublisher(params.env),
  })
}

export async function consumeIngestionReportingBatch(
  batch: IngestionReportingQueueBatch,
  env: Env,
  logger: Logger
): Promise<void> {
  const consumer = createIngestionReportingConsumer({ env, logger })
  await consumer.consumeBatch(batch)
}

export async function consumeIngestionReportingQueueBatch(
  batch: IngestionReportingQueueBatch,
  env: Env,
  executionCtx: ExecutionContext,
  drain?: { flush: () => Promise<void> }
): Promise<void> {
  const batchRequestId = `reporting-queue:${Date.now()}`
  const startedAt = Date.now()
  const { logger, requestLogger } = createStandaloneRequestLogger(
    { requestId: batchRequestId },
    { flush: drain?.flush }
  )

  logger.set({
    service: "ingestion_reporting_queue",
    request: {
      id: batchRequestId,
      timestamp: new Date(startedAt).toISOString(),
      path: "/queues/ingestion-reporting/consume",
    },
    cloud: { platform: "cloudflare" },
    business: { operation: "consume_reporting_batch" },
  })

  let thrown: unknown

  try {
    await consumeIngestionReportingBatch(batch, env, logger)
  } catch (error) {
    thrown = error
    logger.warn("ingestion reporting queue batch will retry", {
      reporting_envelope_count: batch.messages.length,
      reporting_retry_count: batch.messages.length,
    })
    logger.error(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    const duration = Math.max(0, Date.now() - startedAt)
    const status = thrown ? 500 : 200

    requestLogger.set({ status, duration, request: { status, duration } })
    requestLogger.emit({ status, duration, request: { status, duration } })

    if (drain) {
      executionCtx.waitUntil(drain.flush())
    }
  }
}

export function chunkIngestionEventsForTinybird(
  events: AnalyticsIngestionEvent[],
  limits: {
    maxEventsPerRequest?: number
    maxNdjsonBytesPerRequest?: number
  } = {}
): AnalyticsIngestionEvent[][] {
  const maxEventsPerRequest =
    limits.maxEventsPerRequest ?? TINYBIRD_MAX_INGESTION_EVENTS_PER_REQUEST
  const maxNdjsonBytesPerRequest =
    limits.maxNdjsonBytesPerRequest ?? TINYBIRD_MAX_INGESTION_EVENT_NDJSON_BYTES_PER_REQUEST

  if (maxEventsPerRequest <= 0 || maxNdjsonBytesPerRequest <= 0) {
    throw new Error("Tinybird ingestion event chunk limits must be greater than zero")
  }

  const chunks: AnalyticsIngestionEvent[][] = []
  let currentChunk: AnalyticsIngestionEvent[] = []
  let currentChunkBytes = 0

  for (const event of events) {
    const parsedEvent = ingestionEventSchemaV1.parse(event)
    const eventBytes = ndjsonByteLength(parsedEvent)

    if (eventBytes > maxNdjsonBytesPerRequest) {
      throw new Error(
        `Tinybird ingestion event exceeds NDJSON byte limit: ${maxNdjsonBytesPerRequest}`
      )
    }

    const nextChunkWouldExceedCount = currentChunk.length >= maxEventsPerRequest
    const nextChunkWouldExceedBytes =
      currentChunk.length > 0 && currentChunkBytes + eventBytes > maxNdjsonBytesPerRequest

    if (nextChunkWouldExceedCount || nextChunkWouldExceedBytes) {
      chunks.push(currentChunk)
      currentChunk = []
      currentChunkBytes = 0
    }

    currentChunk.push(parsedEvent)
    currentChunkBytes += eventBytes
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk)
  }

  return chunks
}

async function publishIngestionEventChunks(
  chunks: AnalyticsIngestionEvent[][],
  ingestIngestionEvents: IngestionEventIngest
): Promise<void> {
  for (const chunk of chunks) {
    const result = await ingestIngestionEvents(chunk)
    const successful = result?.successful_rows ?? 0
    const quarantined = result?.quarantined_rows ?? 0

    if (successful !== chunk.length || quarantined !== 0) {
      throw new Error(
        `Tinybird ingestion events ingestion failed: expected=${chunk.length} successful=${successful} quarantined=${quarantined}`
      )
    }
  }
}

function buildIngestionEvent(
  record: IngestionReportingEnvelope["auditRecords"][number]
): AnalyticsIngestionEvent {
  const payload = auditPayloadForIngestionEventSchema.parse(JSON.parse(record.auditPayloadJson))

  return {
    event_id: payload.id,
    canonical_audit_id: record.canonicalAuditId,
    payload_hash: record.payloadHash,
    workspace_id: record.workspaceId,
    project_id: record.projectId,
    customer_id: record.customerId,
    environment: record.environment,
    api_key_id: record.apiKeyId,
    source_type: record.sourceType,
    source_id: record.sourceId,
    source_name: record.sourceName,
    event_slug: payload.slug,
    idempotency_key: record.idempotencyKey,
    state: record.status,
    rejection_reason: record.rejectionReason ?? null,
    failure_stage: record.failureStage ?? null,
    failure_reason: record.failureReason ?? null,
    failure_message: record.failureMessage ?? null,
    replayable: record.replayable ?? false,
    payload_json: record.payloadJson ?? null,
    r2_object_key: record.r2ObjectKey ?? null,
    timestamp: payload.timestamp,
    received_at: record.firstSeenAt,
    handled_at: record.handledAt,
    created_at: Date.now(),
  }
}

function ndjsonByteLength(value: unknown): number {
  return textEncoder.encode(`${JSON.stringify(value)}\n`).byteLength
}
