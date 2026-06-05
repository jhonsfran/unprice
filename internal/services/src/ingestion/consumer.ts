import type { Logger } from "@unprice/logs"
import type { IngestionMessageProcessingResult } from "./interface"
import { type IngestionQueueMessage, partitionDuplicateQueuedMessages } from "./message"
import {
  type IngestionQueueBatch,
  ackDuplicateQueuedMessages,
  applyIngestionGroupResults,
  groupQueuedMessagesByCustomer,
  parseIngestionQueueBatchMessages,
  retryQueuedMessages,
} from "./queue-consumer-helpers"

export type { IngestionQueueBatch, IngestionQueueBatchMessage } from "./queue-consumer-helpers"

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
    const validMessages = parseIngestionQueueBatchMessages(batch, this.logger)

    if (validMessages.length === 0) {
      this.logger.debug("No messages to process")
      return
    }

    const { duplicates, unique } = partitionDuplicateQueuedMessages(validMessages)

    ackDuplicateQueuedMessages(duplicates, this.logger)

    if (unique.length === 0) {
      this.logger.debug("no unique messages to process")
      return
    }

    for (const group of groupQueuedMessagesByCustomer(unique)) {
      try {
        const groupResults = await this.processor.processCustomerGroup({
          customerId: group.customerId,
          messages: group.messages.map((message) => message.body),
          projectId: group.projectId,
        })

        applyIngestionGroupResults({
          logger: this.logger,
          queueMessages: group.messages,
          results: groupResults,
        })
      } catch (error) {
        this.logger.error("ingestion queue group processing failed", {
          customerId: group.customerId,
          projectId: group.projectId,
          error,
        })

        retryQueuedMessages(group.messages)
      }
    }
  }
}
