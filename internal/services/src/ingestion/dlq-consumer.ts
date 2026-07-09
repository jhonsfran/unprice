import type { Logger } from "@unprice/logs"
import { IngestionMessageOutcomes } from "./message-outcomes"
import {
  type IngestionQueueBatch,
  groupQueuedMessagesByCustomer,
  parseIngestionQueueBatchMessages,
} from "./queue-consumer-helpers"
import type { IngestionReportingOutcomeDispatcher } from "./reporting-dispatcher"

export const DLQ_FAILURE_REASON = "dead_letter_exhausted_retries"

export class IngestionDlqConsumer {
  private readonly logger: Pick<Logger, "debug" | "error" | "warn">
  private readonly messageOutcomes: IngestionMessageOutcomes
  private readonly reportingDispatcher: IngestionReportingOutcomeDispatcher

  constructor(opts: {
    logger: Pick<Logger, "debug" | "error" | "warn">
    now: () => number
    reportingDispatcher: IngestionReportingOutcomeDispatcher
  }) {
    this.logger = opts.logger
    this.messageOutcomes = new IngestionMessageOutcomes({ logger: opts.logger, now: opts.now })
    this.reportingDispatcher = opts.reportingDispatcher
  }

  public async consumeBatch(batch: IngestionQueueBatch): Promise<void> {
    const validMessages = parseIngestionQueueBatchMessages(batch, this.logger)
    if (validMessages.length === 0) {
      return
    }

    for (const group of groupQueuedMessagesByCustomer(validMessages)) {
      const outcomes = this.messageOutcomes.buildFailedOutcomes(
        group.messages.map((message) => message.body),
        {
          failureStage: "raw_ingestion",
          failureReason: DLQ_FAILURE_REASON,
        }
      )

      try {
        await this.reportingDispatcher.enqueueOutcomes({
          customerId: group.customerId,
          outcomes,
          projectId: group.projectId,
        })
      } catch (error) {
        const reportingError = error instanceof Error ? error : new Error(String(error))
        this.logger.error(reportingError, {
          operation: "ingestion_dlq_reporting_enqueue",
          projectId: group.projectId,
          customerId: group.customerId,
          dead_letter_count: group.messages.length,
        })
        for (const message of group.messages) {
          message.retry()
        }
        continue
      }

      this.logger.error("ingestion events dead-lettered", {
        projectId: group.projectId,
        customerId: group.customerId,
        dead_letter_count: group.messages.length,
        idempotency_keys: group.messages.map((message) => message.body.idempotencyKey),
      })
      for (const message of group.messages) {
        message.ack()
      }
    }
  }
}
