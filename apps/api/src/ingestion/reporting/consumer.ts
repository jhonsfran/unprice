import { Analytics } from "@unprice/analytics"
import type { Logger } from "@unprice/logs"
import { createStandaloneRequestLogger } from "@unprice/observability"
import {
  type IngestionReportingEnvelope,
  ingestionReportingEnvelopeSchema,
} from "@unprice/services/ingestion"
import type { Env } from "~/env"
import { type AuditRecordPublisher, createAuditRecordPublisher } from "./audit-record-publisher"
import {
  type MeterFactIngest,
  chunkMeterFactsForTinybird,
  publishMeterFactChunks,
} from "./tinybird-meter-facts"

export { chunkMeterFactsForTinybird } from "./tinybird-meter-facts"

export type IngestionReportingQueueBatchMessage = {
  ack: () => void
  body: IngestionReportingEnvelope
  retry: (options?: { delaySeconds?: number }) => void
}

export type IngestionReportingQueueBatch = {
  messages: readonly IngestionReportingQueueBatchMessage[]
}

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
    await publishMeterFactChunks(tinybirdChunks, this.ingestMeterFacts)

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
