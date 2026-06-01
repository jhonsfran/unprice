import type { PipelineRecord } from "cloudflare:pipelines"
import {
  Analytics,
  type AnalyticsEntitlementMeterFact,
  entitlementMeterFactSchemaV1,
} from "@unprice/analytics"
import { parseLakehouseEvent } from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import { createStandaloneRequestLogger } from "@unprice/observability"
import {
  type IngestionReportingAuditRecord,
  type IngestionReportingEnvelope,
  ingestionReportingEnvelopeSchema,
} from "@unprice/services/ingestion"
import type { Env } from "~/env"

const TINYBIRD_MAX_FACTS_PER_REQUEST = 5_000
const TINYBIRD_MAX_NDJSON_BYTES_PER_REQUEST = 5 * 1024 * 1024

const textEncoder = new TextEncoder()

type TinybirdIngestResult = {
  quarantined_rows?: number
  successful_rows?: number
}

export type IngestionReportingQueueBatchMessage = {
  ack: () => void
  body: IngestionReportingEnvelope
  retry: (options?: { delaySeconds?: number }) => void
}

export type IngestionReportingQueueBatch = {
  messages: readonly IngestionReportingQueueBatchMessage[]
}

type AuditRecordPublisher = (records: IngestionReportingAuditRecord[]) => Promise<void>
type MeterFactIngest = (
  facts: AnalyticsEntitlementMeterFact[]
) => Promise<TinybirdIngestResult | undefined>

export class IngestionReportingConsumer {
  private readonly logger: Logger
  private readonly publishAuditRecords: AuditRecordPublisher
  private readonly ingestMeterFacts: MeterFactIngest

  constructor(opts: {
    ingestMeterFacts: MeterFactIngest
    logger: Logger
    publishAuditRecords: AuditRecordPublisher
  }) {
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
    const pipelineSendCount = auditRecords.length > 0 ? 1 : 0

    await this.publishAuditRecords(auditRecords)
    await this.publishMeterFacts(meterFacts)

    for (const message of batch.messages) {
      message.ack()
    }

    this.logger.info("ingestion reporting queue batch", {
      reporting_envelope_count: envelopes.length,
      reporting_audit_record_count: auditRecords.length,
      reporting_meter_fact_count: meterFacts.length,
      reporting_pipeline_record_count: auditRecords.length,
      reporting_tinybird_request_count: tinybirdChunks.length,
      meter_facts_per_tinybird_request:
        tinybirdChunks.length > 0 ? meterFacts.length / tinybirdChunks.length : 0,
      pipeline_records_per_pipeline_send:
        pipelineSendCount > 0 ? auditRecords.length / pipelineSendCount : 0,
    })
  }

  private async publishMeterFacts(facts: AnalyticsEntitlementMeterFact[]): Promise<void> {
    for (const chunk of chunkMeterFactsForTinybird(facts)) {
      const result = await this.ingestMeterFacts(chunk)
      const successful = result?.successful_rows ?? 0
      const quarantined = result?.quarantined_rows ?? 0

      if (successful !== chunk.length || quarantined !== 0) {
        throw new Error(
          `Tinybird entitlement meter facts ingestion failed: expected=${chunk.length} successful=${successful} quarantined=${quarantined}`
        )
      }
    }
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

export function chunkMeterFactsForTinybird(
  facts: AnalyticsEntitlementMeterFact[],
  limits: {
    maxFactsPerRequest?: number
    maxNdjsonBytesPerRequest?: number
  } = {}
): AnalyticsEntitlementMeterFact[][] {
  const maxFactsPerRequest = limits.maxFactsPerRequest ?? TINYBIRD_MAX_FACTS_PER_REQUEST
  const maxNdjsonBytesPerRequest =
    limits.maxNdjsonBytesPerRequest ?? TINYBIRD_MAX_NDJSON_BYTES_PER_REQUEST

  if (maxFactsPerRequest <= 0 || maxNdjsonBytesPerRequest <= 0) {
    throw new Error("Tinybird chunk limits must be greater than zero")
  }

  const chunks: AnalyticsEntitlementMeterFact[][] = []
  let currentChunk: AnalyticsEntitlementMeterFact[] = []
  let currentChunkBytes = 0

  for (const fact of facts) {
    const parsedFact = entitlementMeterFactSchemaV1.parse(fact)
    const factBytes = ndjsonByteLength(parsedFact)

    if (factBytes > maxNdjsonBytesPerRequest) {
      throw new Error(
        `Tinybird entitlement meter fact exceeds NDJSON byte limit: ${maxNdjsonBytesPerRequest}`
      )
    }

    const nextChunkWouldExceedCount = currentChunk.length >= maxFactsPerRequest
    const nextChunkWouldExceedBytes =
      currentChunk.length > 0 && currentChunkBytes + factBytes > maxNdjsonBytesPerRequest

    if (nextChunkWouldExceedCount || nextChunkWouldExceedBytes) {
      chunks.push(currentChunk)
      currentChunk = []
      currentChunkBytes = 0
    }

    currentChunk.push(parsedFact)
    currentChunkBytes += factBytes
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk)
  }

  return chunks
}

function createAuditRecordPublisher(
  env: Pick<Env, "APP_ENV" | "LOCAL_PIPELINE_URL" | "PIPELINE_EVENTS">
): AuditRecordPublisher {
  return async (records) => {
    if (records.length === 0) {
      return
    }

    const events = records.map((record): PipelineRecord => {
      const payload = JSON.parse(record.auditPayloadJson)
      return parseLakehouseEvent("events", payload) as PipelineRecord
    })

    const localPipelineUrl = resolveLocalPipelineUrl(env)

    if (localPipelineUrl) {
      await sendToLocalPipeline(localPipelineUrl, events)
      return
    }

    if (!env.PIPELINE_EVENTS) {
      throw new Error("PIPELINE_EVENTS binding is required when LOCAL_PIPELINE_URL is not set")
    }

    await env.PIPELINE_EVENTS.send(events)
  }
}

function resolveLocalPipelineUrl(env: Pick<Env, "APP_ENV" | "LOCAL_PIPELINE_URL">): string | null {
  if (env.APP_ENV !== "development") {
    return null
  }

  const localPipelineUrl = env.LOCAL_PIPELINE_URL?.trim()
  return localPipelineUrl && localPipelineUrl.length > 0 ? localPipelineUrl : null
}

async function sendToLocalPipeline(url: string, events: PipelineRecord[]): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(events),
  })

  if (!response.ok) {
    throw new Error(`local pipeline sink failed with status ${response.status}`)
  }
}

function ndjsonByteLength(value: unknown): number {
  return textEncoder.encode(`${JSON.stringify(value)}\n`).byteLength
}
