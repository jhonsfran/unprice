import type { Logger } from "@unprice/logs"
import { type IngestionReportingEnvelope, ingestionReportingEnvelopeSchema } from "./reporting"

export const REPORTING_MAX_REDRIVES = 3

const REDRIVE_BASE_DELAY_SECONDS = 60

type ReportingDlqMessage = {
  ack: () => void
  body: IngestionReportingEnvelope
  retry: (options?: { delaySeconds?: number }) => void
}

export type ReportingRedrive = (
  envelope: IngestionReportingEnvelope,
  options: { delaySeconds: number }
) => Promise<void>

export class ReportingDlqConsumer {
  private readonly logger: Pick<Logger, "error" | "warn">
  private readonly redrive: ReportingRedrive

  constructor(opts: {
    logger: Pick<Logger, "error" | "warn">
    redrive: ReportingRedrive
  }) {
    this.logger = opts.logger
    this.redrive = opts.redrive
  }

  public async consumeBatch(batch: {
    messages: readonly ReportingDlqMessage[]
  }): Promise<void> {
    for (const message of batch.messages) {
      const parsed = ingestionReportingEnvelopeSchema.safeParse(message.body)
      if (!parsed.success) {
        this.logger.error("dropping malformed reporting DLQ message", {
          errors: parsed.error.issues,
        })
        message.ack()
        continue
      }

      const envelope = parsed.data
      if (envelope.redriveCount >= REPORTING_MAX_REDRIVES) {
        this.logger.error("ingestion reporting envelope permanently failed", {
          envelope_id: envelope.envelopeId,
          project_id: envelope.projectId,
          customer_id: envelope.customerId,
          redrive_count: envelope.redriveCount,
          reporting_audit_record_count: envelope.auditRecords.length,
          reporting_meter_fact_count: envelope.meterFacts.length,
          envelope_json: JSON.stringify(envelope),
        })
        message.ack()
        continue
      }

      const next = {
        ...envelope,
        redriveCount: envelope.redriveCount + 1,
      }
      const delaySeconds = REDRIVE_BASE_DELAY_SECONDS * next.redriveCount

      try {
        await this.redrive(next, { delaySeconds })
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught))
        this.logger.error(error, {
          operation: "ingestion_reporting_dlq_redrive",
          envelope_id: envelope.envelopeId,
          project_id: envelope.projectId,
          customer_id: envelope.customerId,
          redrive_count: envelope.redriveCount,
          reporting_audit_record_count: envelope.auditRecords.length,
          reporting_meter_fact_count: envelope.meterFacts.length,
          envelope_json: JSON.stringify(envelope),
        })
        message.retry()
        continue
      }

      this.logger.warn("ingestion reporting envelope re-driven from DLQ", {
        envelope_id: envelope.envelopeId,
        project_id: envelope.projectId,
        customer_id: envelope.customerId,
        redrive_count: next.redriveCount,
        delay_seconds: delaySeconds,
      })
      message.ack()
    }
  }
}
