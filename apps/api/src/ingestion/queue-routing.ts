export type IngestionQueueKind = "raw" | "raw_dlq" | "reporting" | "reporting_dlq"

type IngestionQueueConsumer = (batch: MessageBatch<unknown>) => Promise<void>

type IngestionQueueDispatchOptions = {
  consumers: Record<IngestionQueueKind, IngestionQueueConsumer>
  onUnknownQueue: (failure: { queue: string }) => void
}

/**
 * Queue names are defined in apps/api/wrangler.jsonc. Order matters:
 * "reporting-dlq" starts with the reporting queue prefix.
 */
export function classifyIngestionQueue(queueName: string): IngestionQueueKind | undefined {
  if (queueName.startsWith("unprice-api-ingestion-reporting-dlq-")) return "reporting_dlq"
  if (queueName.startsWith("unprice-api-ingestion-reporting-")) return "reporting"
  if (queueName.startsWith("unprice-api-ingestion-dlq-")) return "raw_dlq"
  if (queueName.startsWith("unprice-api-ingestion-shard-")) return "raw"
  return undefined
}

export async function dispatchIngestionQueueBatch(
  batch: MessageBatch<unknown>,
  options: IngestionQueueDispatchOptions
): Promise<void> {
  const kind = classifyIngestionQueue(batch.queue)
  if (!kind) {
    for (const message of batch.messages) {
      message.retry()
    }
    options.onUnknownQueue({ queue: batch.queue })
    return
  }

  await options.consumers[kind](batch)
}
