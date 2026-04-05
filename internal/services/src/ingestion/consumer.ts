import type { Logger } from "@unprice/logs"
import type { IngestionMessageProcessingResult } from "./interface"
import {
  type IngestionQueueConsumerMessage,
  type IngestionQueueMessage,
  type IngestionQueueRetryOptions,
  ingestionQueueMessageSchema,
  partitionDuplicateQueuedMessages,
  sortQueuedMessages,
} from "./message"

export type IngestionQueueBatchMessage = {
  ack: () => void
  body: IngestionQueueMessage
  retry: (options?: IngestionQueueRetryOptions) => void
}

export type IngestionQueueBatch = {
  messages: readonly IngestionQueueBatchMessage[]
}

type CustomerQueueGroup = {
  customerId: string
  messages: IngestionQueueConsumerMessage[]
  projectId: string
}

type GroupProcessor = {
  processCustomerGroup(params: {
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<IngestionMessageProcessingResult[]>
}

export class IngestionQueueConsumer {
  private readonly logger: Logger
  private readonly processor: GroupProcessor

  constructor(opts: {
    logger: Logger
    processor: GroupProcessor
  }) {
    this.logger = opts.logger
    this.processor = opts.processor
  }

  public async consumeBatch(batch: IngestionQueueBatch): Promise<void> {
    const validMessages = this.parseBatchMessages(batch)

    if (validMessages.length === 0) {
      this.logger.debug("No messages to process")
      return
    }

    const { duplicates, unique } = partitionDuplicateQueuedMessages(validMessages)

    this.ackDuplicateMessages(duplicates)

    if (unique.length === 0) {
      this.logger.debug("no unique messages to process")
      return
    }

    for (const group of this.groupMessagesByCustomer(unique)) {
      try {
        const groupResults = await this.processor.processCustomerGroup({
          customerId: group.customerId,
          messages: group.messages.map((message) => message.body),
          projectId: group.projectId,
        })

        this.applyGroupResults(group.messages, groupResults)
      } catch (error) {
        this.logger.error("ingestion queue group processing failed", {
          customerId: group.customerId,
          projectId: group.projectId,
          error,
        })

        for (const message of group.messages) {
          message.retry()
        }
      }
    }
  }

  private parseBatchMessages(batch: IngestionQueueBatch): IngestionQueueConsumerMessage[] {
    return batch.messages.flatMap((message) => {
      const parsed = ingestionQueueMessageSchema.safeParse(message.body)

      if (!parsed.success) {
        this.logger.error("dropping malformed ingestion queue message", {
          errors: parsed.error.issues,
        })
        message.ack()
        return []
      }

      return [
        {
          ack: message.ack.bind(message),
          body: parsed.data,
          retry: message.retry.bind(message),
        } satisfies IngestionQueueConsumerMessage,
      ]
    })
  }

  private ackDuplicateMessages(duplicates: IngestionQueueConsumerMessage[]): void {
    for (const duplicate of duplicates) {
      this.logger.debug("dropping duplicate ingestion queue message from same batch", {
        projectId: duplicate.body.projectId,
        customerId: duplicate.body.customerId,
        eventId: duplicate.body.id,
        idempotencyKey: duplicate.body.idempotencyKey,
      })
      duplicate.ack()
    }
  }

  private groupMessagesByCustomer(messages: IngestionQueueConsumerMessage[]): CustomerQueueGroup[] {
    const groups = new Map<string, CustomerQueueGroup>()

    for (const message of messages) {
      const key = `${message.body.projectId}:${message.body.customerId}`
      const existing = groups.get(key)

      if (existing) {
        existing.messages.push(message)
        continue
      }

      groups.set(key, {
        projectId: message.body.projectId,
        customerId: message.body.customerId,
        messages: [message],
      })
    }

    return [...groups.values()].map((group) => ({
      ...group,
      messages: group.messages.sort(sortQueuedMessages),
    }))
  }

  private applyGroupResults(
    queueMessages: IngestionQueueConsumerMessage[],
    results: IngestionMessageProcessingResult[]
  ): void {
    const resultsByKey = new Map<string, IngestionMessageProcessingResult>(
      results.map((result) => [this.buildResultKey(result.message), result])
    )

    for (const queueMessage of queueMessages) {
      const result = resultsByKey.get(this.buildResultKey(queueMessage.body))

      if (!result) {
        this.logger.error("missing ingestion processing result for queued message", {
          customerId: queueMessage.body.customerId,
          eventId: queueMessage.body.id,
          idempotencyKey: queueMessage.body.idempotencyKey,
          projectId: queueMessage.body.projectId,
        })
        queueMessage.retry()
        continue
      }

      if (result.disposition.action === "ack") {
        queueMessage.ack()
        continue
      }

      queueMessage.retry(
        result.disposition.retryAfterSeconds
          ? {
              delaySeconds: result.disposition.retryAfterSeconds,
            }
          : undefined
      )
    }
  }

  private buildResultKey(message: IngestionQueueMessage): string {
    return `${message.projectId}:${message.customerId}:${message.idempotencyKey}`
  }
}
