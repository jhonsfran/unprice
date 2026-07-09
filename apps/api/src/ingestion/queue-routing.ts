export type IngestionQueueKind = "raw" | "raw_dlq" | "reporting" | "reporting_dlq"

type QueueBodySchema<T> = {
  safeParse: (
    value: unknown
  ) => { success: true; data: T } | { success: false; error: { issues: unknown } }
}

type MalformedQueueMessageHandler = (failure: { queue: string; errors: unknown }) => void

type IngestionQueueDispatchOptions<TRaw, TReporting> = {
  consumeRaw: (batch: MessageBatch<TRaw>) => Promise<void>
  consumeRawDlq: (batch: MessageBatch<TRaw>) => Promise<void>
  consumeReporting: (batch: MessageBatch<TReporting>) => Promise<void>
  onMalformed: MalformedQueueMessageHandler
  rawSchema: QueueBodySchema<TRaw>
  reportingSchema: QueueBodySchema<TReporting>
}

/**
 * Queue names are defined in apps/api/wrangler.jsonc. Order matters:
 * "reporting-dlq" contains "reporting" and "dlq" as substrings.
 */
export function classifyIngestionQueue(queueName: string): IngestionQueueKind {
  if (queueName.startsWith("unprice-api-ingestion-reporting-dlq-")) return "reporting_dlq"
  if (queueName.startsWith("unprice-api-ingestion-reporting-")) return "reporting"
  if (queueName.startsWith("unprice-api-ingestion-dlq-")) return "raw_dlq"
  return "raw"
}

export async function dispatchIngestionQueueBatch<TRaw, TReporting>(
  batch: MessageBatch<unknown>,
  options: IngestionQueueDispatchOptions<TRaw, TReporting>
): Promise<void> {
  const kind = classifyIngestionQueue(batch.queue)
  switch (kind) {
    case "raw": {
      const messages = parseBatchBodies(batch, options.rawSchema, options.onMalformed)
      if (messages.length > 0) {
        await options.consumeRaw(withMessages(batch, messages))
      }
      return
    }
    case "raw_dlq": {
      const messages = parseBatchBodies(batch, options.rawSchema, options.onMalformed)
      if (messages.length > 0) {
        await options.consumeRawDlq(withMessages(batch, messages))
      }
      return
    }
    case "reporting": {
      const messages = parseBatchBodies(batch, options.reportingSchema, options.onMalformed)
      if (messages.length > 0) {
        await options.consumeReporting(withMessages(batch, messages))
      }
      return
    }
    case "reporting_dlq": {
      // Reporting DLQ consumption lands in its dedicated operability task.
      throw new Error(`No consumer wired for ingestion queue kind: ${kind} (${batch.queue})`)
    }
  }

  return kind satisfies never
}

function parseBatchBodies<T>(
  batch: MessageBatch<unknown>,
  schema: QueueBodySchema<T>,
  onMalformed: MalformedQueueMessageHandler
): Message<T>[] {
  const parsed: Message<T>[] = []
  for (const message of batch.messages) {
    const result = schema.safeParse(message.body)
    if (result.success) {
      parsed.push(withParsedBody(message, result.data))
      continue
    }
    onMalformed({ queue: batch.queue, errors: result.error.issues })
    message.ack()
  }
  return parsed
}

function withParsedBody<T>(message: Message<unknown>, body: T): Message<T> {
  return {
    ...message,
    ack: message.ack.bind(message),
    body,
    retry: message.retry.bind(message),
  } as Message<T>
}

function withMessages<T>(batch: MessageBatch<unknown>, messages: Message<T>[]): MessageBatch<T> {
  return {
    ...batch,
    messages,
  } as MessageBatch<T>
}
