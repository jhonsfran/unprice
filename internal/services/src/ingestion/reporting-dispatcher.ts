import type { Logger } from "@unprice/logs"
import { type IngestionReportingQueueClient, chunkIngestionReportingEnvelope } from "./reporting"
import {
  type IngestionReportingOutcome,
  buildIngestionReportingEnvelope,
} from "./reporting-envelope"

export class IngestionReportingDispatcher {
  private readonly logger: Pick<Logger, "error">
  private readonly now: () => number
  private readonly reportingClient: IngestionReportingQueueClient

  constructor(opts: {
    logger: Pick<Logger, "error">
    now: () => number
    reportingClient: IngestionReportingQueueClient
  }) {
    this.logger = opts.logger
    this.now = opts.now
    this.reportingClient = opts.reportingClient
  }

  public async enqueueOutcomes(params: {
    customerId: string
    outcomes: IngestionReportingOutcome[]
    projectId: string
  }): Promise<void> {
    const { customerId, outcomes, projectId } = params

    if (outcomes.length === 0) {
      return
    }

    const envelope = await buildIngestionReportingEnvelope({
      customerId,
      now: this.now,
      outcomes,
      projectId,
    })
    const chunks = chunkIngestionReportingEnvelope(envelope)

    try {
      await Promise.all(chunks.map((chunk) => this.reportingClient.send(chunk)))
    } catch (error) {
      this.logger.error("ingestion reporting enqueue failed", {
        projectId,
        customerId,
        reporting_envelope_count: chunks.length,
        reporting_audit_record_count: envelope.auditRecords.length,
        reporting_meter_fact_count: envelope.meterFacts.length,
        reporting_enqueue_failure_count: chunks.length,
        error,
      })

      throw error
    }
  }
}

export type IngestionReportingOutcomeDispatcher = Pick<
  IngestionReportingDispatcher,
  "enqueueOutcomes"
>
