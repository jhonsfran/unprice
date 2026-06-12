import type { Logger } from "@unprice/logs"
import type {
  CustomerMessageGroupPreparer,
  PreparedCustomerMessageGroup,
} from "./entitlement-context"
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

  constructor(opts: {
    entitlementContext: CustomerMessageGroupPreparer
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
  }

  public async processCustomerGroup(params: {
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<IngestionMessageProcessingResult[]> {
    const { customerId, projectId } = params
    const messages = [...params.messages].sort(sortIngestionMessages)

    try {
      const { freshMessages, tooOldOutcomes } = this.messageOutcomes.partitionTooOldMessages({
        customerId,
        messages,
        projectId,
      })

      if (tooOldOutcomes.length > 0) {
        await this.enqueueOutcomesToReporting(projectId, customerId, tooOldOutcomes)
      }

      if (freshMessages.length === 0) {
        return mapOutcomesToAckResults(tooOldOutcomes)
      }

      let preparedGroup = await this.entitlementContext.prepareCustomerMessageGroup({
        customerId,
        messages: freshMessages,
        projectId,
      })

      const customerNotFoundOutcomes = this.resolveCustomerNotFoundOutcomes({
        customerId,
        preparedGroup,
        projectId,
      })
      if (customerNotFoundOutcomes) {
        await this.enqueueOutcomesToReporting(projectId, customerId, customerNotFoundOutcomes)
        return [
          ...mapOutcomesToAckResults(customerNotFoundOutcomes),
          ...mapOutcomesToAckResults(tooOldOutcomes),
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

      return [...mapOutcomesToAckResults(freshOutcomes), ...mapOutcomesToAckResults(tooOldOutcomes)]
    } catch (error) {
      this.logger.error("raw ingestion queue processing failed", {
        projectId,
        customerId,
        error,
      })

      return messages.map((message) => retryMessage(message))
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

    await this.reportingDispatcher.enqueueOutcomes({ customerId, outcomes, projectId })
  }
}

function sortIngestionMessages(left: IngestionQueueMessage, right: IngestionQueueMessage): number {
  return left.timestamp - right.timestamp || left.idempotencyKey.localeCompare(right.idempotencyKey)
}
