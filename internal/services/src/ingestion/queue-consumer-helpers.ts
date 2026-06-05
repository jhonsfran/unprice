import type { Logger } from "@unprice/logs"
import type { IngestionMessageProcessingResult } from "./interface"
import {
  type IngestionQueueConsumerMessage,
  type IngestionQueueMessage,
  ingestionQueueMessageSchema,
  sortQueuedMessages,
} from "./message"

export type IngestionQueueBatchMessage = {
  ack: () => void
  body: IngestionQueueMessage
  retry: (options?: { delaySeconds?: number }) => void
}

export type IngestionQueueBatch = {
  messages: readonly IngestionQueueBatchMessage[]
}

export type CustomerQueueGroup = {
  customerId: string
  messages: IngestionQueueConsumerMessage[]
  projectId: string
}

export function parseIngestionQueueBatchMessages(
  batch: IngestionQueueBatch,
  logger: Pick<Logger, "error">
): IngestionQueueConsumerMessage[] {
  return batch.messages.flatMap((message) => {
    const parsed = ingestionQueueMessageSchema.safeParse(message.body)

    if (!parsed.success) {
      logger.error("dropping malformed ingestion queue message", {
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

export function ackDuplicateQueuedMessages(
  duplicates: IngestionQueueConsumerMessage[],
  logger: Pick<Logger, "debug">
): void {
  for (const duplicate of duplicates) {
    logger.debug("dropping duplicate ingestion queue message from same batch", {
      projectId: duplicate.body.projectId,
      customerId: duplicate.body.customerId,
      eventId: duplicate.body.id,
      idempotencyKey: duplicate.body.idempotencyKey,
    })
    duplicate.ack()
  }
}

export function groupQueuedMessagesByCustomer(
  messages: IngestionQueueConsumerMessage[]
): CustomerQueueGroup[] {
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

export function applyIngestionGroupResults(params: {
  logger: Pick<Logger, "error">
  queueMessages: IngestionQueueConsumerMessage[]
  results: IngestionMessageProcessingResult[]
}): void {
  const resultsByKey = new Map<string, IngestionMessageProcessingResult>(
    params.results.map((result) => [buildResultKey(result.message), result])
  )

  for (const queueMessage of params.queueMessages) {
    const result = resultsByKey.get(buildResultKey(queueMessage.body))

    if (!result) {
      params.logger.error("missing ingestion processing result for queued message", {
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

export function retryQueuedMessages(messages: IngestionQueueConsumerMessage[]): void {
  for (const message of messages) {
    message.retry()
  }
}

function buildResultKey(message: IngestionQueueMessage): string {
  return `${message.projectId}:${message.customerId}:${message.idempotencyKey}`
}
