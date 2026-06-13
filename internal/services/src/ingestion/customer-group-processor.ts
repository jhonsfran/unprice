import type { Logger } from "@unprice/logs"
import type {
  CustomerMessageGroupPreparer,
  PreparedCustomerMessageGroup,
} from "./entitlement-context"
import { hasRawProcessingFailureTestMarker } from "./failure-injection"
import type { FanoutMessageOutcome as MessageOutcome } from "./fanout-outcomes"
import type { IngestionMessageProcessingResult, IngestionRejectionReason } from "./interface"
import type { IngestionQueueMessage } from "./message"
import {
  type IngestionMessageOutcomes,
  mapOutcomesToAckResults,
  retryMessage,
} from "./message-outcomes"
import type { IngestionReportingOutcomeDispatcher } from "./reporting-dispatcher"

type PreparedMessageProcessor = {
  process(params: {
    candidateEntitlements: PreparedCustomerMessageGroup["candidateEntitlements"]
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
    rejectionReason?: IngestionRejectionReason
  }): Promise<MessageOutcome[]>
}

type SubscriptionCatchUpProcessor = {
  catchUpForPreparedGroup(params: {
    candidateEntitlements: PreparedCustomerMessageGroup["candidateEntitlements"]
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<{ changed: boolean; caughtUpSubscriptionIds: string[] }>
}

export class IngestionCustomerGroupProcessor {
  private readonly entitlementContext: CustomerMessageGroupPreparer
  private readonly logger: Pick<Logger, "error" | "info">
  private readonly messageOutcomes: IngestionMessageOutcomes
  private readonly preparedMessageProcessor: PreparedMessageProcessor
  private readonly reportingDispatcher: IngestionReportingOutcomeDispatcher
  private readonly subscriptionCatchUp: SubscriptionCatchUpProcessor | undefined
  private readonly enableTestFailureInjection: boolean

  constructor(opts: {
    entitlementContext: CustomerMessageGroupPreparer
    enableTestFailureInjection?: boolean
    logger: Pick<Logger, "error" | "info">
    messageOutcomes: IngestionMessageOutcomes
    preparedMessageProcessor: PreparedMessageProcessor
    reportingDispatcher: IngestionReportingOutcomeDispatcher
    subscriptionCatchUp?: SubscriptionCatchUpProcessor
  }) {
    this.entitlementContext = opts.entitlementContext
    this.logger = opts.logger
    this.messageOutcomes = opts.messageOutcomes
    this.preparedMessageProcessor = opts.preparedMessageProcessor
    this.reportingDispatcher = opts.reportingDispatcher
    this.subscriptionCatchUp = opts.subscriptionCatchUp
    this.enableTestFailureInjection = opts.enableTestFailureInjection ?? false
  }

  public async processCustomerGroup(params: {
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<IngestionMessageProcessingResult[]> {
    const { customerId, projectId } = params
    const messages = [...params.messages].sort(sortIngestionMessages)
    let finalizedOutcomes: MessageOutcome[] = []
    let unfinalizedMessages = messages

    try {
      const { freshMessages, tooOldOutcomes } = this.messageOutcomes.partitionTooOldMessages({
        customerId,
        messages,
        projectId,
      })

      if (tooOldOutcomes.length > 0) {
        await this.enqueueOutcomesToReporting(projectId, customerId, tooOldOutcomes)
        finalizedOutcomes = tooOldOutcomes
        unfinalizedMessages = freshMessages
      }

      if (freshMessages.length === 0) {
        return mapOutcomesToAckResults(finalizedOutcomes)
      }

      if (this.enableTestFailureInjection && hasRawProcessingFailureTestMarker(freshMessages)) {
        throw new Error("raw ingestion processing failure test requested")
      }

      let preparedGroup = await this.entitlementContext.prepareCustomerMessageGroup({
        customerId,
        messages: freshMessages,
        projectId,
      })
      unfinalizedMessages = preparedGroup.messages

      const customerNotFoundOutcomes = this.resolveCustomerNotFoundOutcomes({
        customerId,
        preparedGroup,
        projectId,
      })
      if (customerNotFoundOutcomes) {
        await this.enqueueOutcomesToReporting(projectId, customerId, customerNotFoundOutcomes)
        return [
          ...mapOutcomesToAckResults(customerNotFoundOutcomes),
          ...mapOutcomesToAckResults(finalizedOutcomes),
        ]
      }

      const catchUpResult = await this.subscriptionCatchUp?.catchUpForPreparedGroup({
        customerId,
        projectId,
        messages: preparedGroup.messages,
        candidateEntitlements: preparedGroup.candidateEntitlements,
      })

      if (catchUpResult?.changed) {
        preparedGroup = await this.entitlementContext.prepareCustomerMessageGroup({
          customerId,
          messages: freshMessages,
          projectId,
        })
        unfinalizedMessages = preparedGroup.messages
      }

      const freshOutcomes = await this.processFreshPreparedMessages({
        customerId,
        preparedGroup,
        projectId,
      })

      await this.enqueueOutcomesToReporting(projectId, customerId, freshOutcomes)

      this.logCustomerGroupProcessed({
        customerId,
        freshOutcomes,
        messageCount: messages.length,
        preparedMessageCount: preparedGroup.messages.length,
        projectId,
        tooOldOutcomeCount: tooOldOutcomes.length,
      })

      return [
        ...mapOutcomesToAckResults(freshOutcomes),
        ...mapOutcomesToAckResults(finalizedOutcomes),
      ]
    } catch (error) {
      if (error instanceof IngestionReportingEnqueueError) {
        this.logReportingEnqueueFailure({
          customerId,
          error: error.originalError,
          projectId,
        })

        return [
          ...unfinalizedMessages.map((message) => retryMessage(message)),
          ...mapOutcomesToAckResults(finalizedOutcomes),
        ]
      }

      const failedError = toError(error)
      this.logger.error(failedError, {
        projectId,
        customerId,
        failureReason: "raw_ingestion_queue_processing_failed",
        failureStage: "rating_fact",
        message: "raw ingestion queue processing failed",
      })

      const failedOutcomes = this.messageOutcomes.buildFailedOutcomes(unfinalizedMessages, {
        failureStage: "rating_fact",
        failureReason: "raw_ingestion_queue_processing_failed",
        failureMessage: failedError.message,
      })

      try {
        await this.enqueueOutcomesToReporting(projectId, customerId, failedOutcomes)
      } catch (reportingError) {
        const errorToLog =
          reportingError instanceof IngestionReportingEnqueueError
            ? reportingError.originalError
            : reportingError

        this.logger.error("raw ingestion failure reporting enqueue failed", {
          projectId,
          customerId,
          error: errorToLog,
        })

        return [
          ...unfinalizedMessages.map((message) => retryMessage(message)),
          ...mapOutcomesToAckResults(finalizedOutcomes),
        ]
      }

      return [
        ...mapOutcomesToAckResults(failedOutcomes),
        ...mapOutcomesToAckResults(finalizedOutcomes),
      ]
    }
  }

  private resolveCustomerNotFoundOutcomes(params: {
    customerId: string
    preparedGroup: PreparedCustomerMessageGroup
    projectId: string
  }): MessageOutcome[] | null {
    const { customerId, preparedGroup, projectId } = params
    if (preparedGroup.rejectionReason !== "CUSTOMER_NOT_FOUND") {
      return null
    }

    return this.messageOutcomes.buildCustomerNotFoundOutcomes(preparedGroup.messages, {
      customerId,
      projectId,
      rejectionReason: preparedGroup.rejectionReason,
    })
  }

  private async processFreshPreparedMessages(params: {
    customerId: string
    preparedGroup: PreparedCustomerMessageGroup
    projectId: string
  }): Promise<MessageOutcome[]> {
    const { customerId, preparedGroup, projectId } = params
    if (preparedGroup.messages.length === 0) {
      return []
    }

    return this.preparedMessageProcessor.process({
      candidateEntitlements: preparedGroup.candidateEntitlements,
      customerId,
      messages: preparedGroup.messages,
      projectId,
      rejectionReason: preparedGroup.rejectionReason,
    })
  }

  private logCustomerGroupProcessed(params: {
    customerId: string
    freshOutcomes: MessageOutcome[]
    messageCount: number
    preparedMessageCount: number
    projectId: string
    tooOldOutcomeCount: number
  }): void {
    const {
      customerId,
      freshOutcomes,
      messageCount,
      preparedMessageCount,
      projectId,
      tooOldOutcomeCount,
    } = params
    this.logger.info("raw ingestion customer group", {
      projectId,
      customerId,
      raw_event_count: messageCount,
      fresh_event_count: preparedMessageCount,
      too_old_event_count: tooOldOutcomeCount,
      reporting_envelope_count: freshOutcomes.length > 0 ? 1 : 0,
      reporting_audit_record_count: freshOutcomes.length,
      reporting_meter_fact_count: freshOutcomes.reduce(
        (count, outcome) => count + (outcome.meterFacts?.length ?? 0),
        0
      ),
      raw_events_per_reporting_envelope: freshOutcomes.length,
    })
  }

  private async enqueueOutcomesToReporting(
    projectId: string,
    customerId: string,
    outcomes: MessageOutcome[]
  ): Promise<void> {
    if (outcomes.length === 0) {
      return
    }

    try {
      await this.reportingDispatcher.enqueueOutcomes({ customerId, outcomes, projectId })
    } catch (error) {
      throw new IngestionReportingEnqueueError(error)
    }
  }

  private logReportingEnqueueFailure(params: {
    customerId: string
    error: unknown
    projectId: string
  }): void {
    this.logger.error("raw ingestion reporting enqueue failed", {
      projectId: params.projectId,
      customerId: params.customerId,
      error: params.error,
    })
  }
}

class IngestionReportingEnqueueError extends Error {
  public readonly originalError: unknown

  constructor(originalError: unknown) {
    super("ingestion reporting enqueue failed")
    this.name = "IngestionReportingEnqueueError"
    this.originalError = originalError
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function sortIngestionMessages(left: IngestionQueueMessage, right: IngestionQueueMessage): number {
  return left.timestamp - right.timestamp || left.idempotencyKey.localeCompare(right.idempotencyKey)
}
