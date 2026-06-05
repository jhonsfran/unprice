import type { Logger } from "@unprice/logs"
import { INGESTION_MAX_EVENT_AGE_MS } from "../entitlements"
import type { FanoutMessageOutcome as MessageOutcome } from "./fanout-outcomes"
import type {
  IngestionMessageProcessingResult,
  IngestionOutcome,
  IngestionRejectionReason,
  IngestionSyncResult,
} from "./interface"
import type { IngestionQueueMessage } from "./message"

export class IngestionMessageOutcomes {
  private readonly logger: Pick<Logger, "warn">
  private readonly now: () => number

  constructor(opts: {
    logger: Pick<Logger, "warn">
    now: () => number
  }) {
    this.logger = opts.logger
    this.now = opts.now
  }

  public partitionTooOldMessages(params: {
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): {
    freshMessages: IngestionQueueMessage[]
    tooOldOutcomes: MessageOutcome[]
  } {
    const now = this.now()
    const freshMessages: IngestionQueueMessage[] = []
    const tooOldOutcomes: MessageOutcome[] = []

    for (const message of params.messages) {
      const outcome = this.resolveTooOldOutcome({
        customerId: params.customerId,
        message,
        now,
        projectId: params.projectId,
      })

      if (!outcome) {
        freshMessages.push(message)
        continue
      }

      this.logRejectedMessage({
        customerId: params.customerId,
        message,
        projectId: params.projectId,
        rejectionReason: outcome.rejectionReason,
      })
      tooOldOutcomes.push({ message, outcome })
    }

    return { freshMessages, tooOldOutcomes }
  }

  public resolveTooOldOutcome(params: {
    customerId: string
    message: IngestionQueueMessage
    now?: number
    projectId: string
  }): IngestionOutcome | null {
    const now = params.now ?? this.now()
    const eventAgeMs = now - params.message.timestamp
    if (eventAgeMs <= INGESTION_MAX_EVENT_AGE_MS) {
      return null
    }

    this.logger.warn("raw ingestion event rejected as too old", {
      projectId: params.projectId,
      customerId: params.customerId,
      eventId: params.message.id,
      eventSlug: params.message.slug,
      idempotencyKey: params.message.idempotencyKey,
      eventTimestamp: params.message.timestamp,
      receivedAt: params.message.receivedAt,
      now,
      eventAgeMs,
      maxEventAgeMs: INGESTION_MAX_EVENT_AGE_MS,
      rejectionReason: "EVENT_TOO_OLD",
    })

    return { state: "rejected", rejectionReason: "EVENT_TOO_OLD" }
  }

  public buildCustomerNotFoundOutcomes(
    messages: IngestionQueueMessage[],
    params: {
      customerId: string
      projectId: string
      rejectionReason: "CUSTOMER_NOT_FOUND"
    }
  ): MessageOutcome[] {
    return messages.map((message) => {
      const outcome: IngestionOutcome = {
        state: "rejected",
        rejectionReason: params.rejectionReason,
      }

      this.logRejectedMessage({
        customerId: params.customerId,
        message,
        projectId: params.projectId,
        rejectionReason: outcome.rejectionReason,
      })

      return { message, outcome }
    })
  }

  public logRejectedMessage(params: {
    customerId: string
    message: IngestionQueueMessage
    projectId: string
    rejectionReason?: IngestionRejectionReason
  }): void {
    const { customerId, message, projectId, rejectionReason } = params
    this.logger.warn("raw ingestion message rejected", {
      projectId,
      customerId,
      eventId: message.id,
      eventSlug: message.slug,
      idempotencyKey: message.idempotencyKey,
      rejectionReason,
    })
  }
}

export function mapOutcomesToAckResults(
  outcomes: MessageOutcome[]
): IngestionMessageProcessingResult[] {
  return outcomes.map((outcome) => ackMessage(outcome.message))
}

export function ackMessage(message: IngestionQueueMessage): IngestionMessageProcessingResult {
  return {
    message,
    disposition: {
      action: "ack",
    },
  }
}

export function retryMessage(
  message: IngestionQueueMessage,
  retryAfterSeconds?: number
): IngestionMessageProcessingResult {
  return {
    message,
    disposition: {
      action: "retry",
      retryAfterSeconds,
    },
  }
}

export function toSyncResult(params: {
  allowed: boolean
  message?: string
  outcome: IngestionOutcome
}): IngestionSyncResult {
  const { allowed, message, outcome } = params
  return {
    allowed,
    message,
    rejectionReason: outcome.rejectionReason,
    state: outcome.state,
  }
}
