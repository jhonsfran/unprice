import type { Logger } from "@unprice/logs"
import type { IngestionQueueMessage, RawIngestionQueueClient } from "@unprice/services/ingestion"

const SEND_RETRIES = 3
const SEND_BASE_DELAY_MS = 100

export function selectQueueShardIndex(customerId: string, shardCount: number): number {
  let hash = 0

  for (let index = 0; index < customerId.length; index++) {
    hash = (hash * 31 + customerId.charCodeAt(index)) >>> 0
  }

  return hash % shardCount
}

export class CloudflareRawIngestionQueueClient implements RawIngestionQueueClient {
  private readonly baseDelayMs: number
  private readonly logger: Pick<Logger, "error" | "warn">
  private readonly queues: readonly Queue<IngestionQueueMessage>[]

  constructor(opts: {
    logger: Pick<Logger, "error" | "warn">
    queues: readonly Queue<IngestionQueueMessage>[]
    baseDelayMs?: number
  }) {
    if (opts.queues.length === 0) {
      throw new Error("CloudflareRawIngestionQueueClient requires at least one queue shard")
    }

    this.baseDelayMs = opts.baseDelayMs ?? SEND_BASE_DELAY_MS
    this.logger = opts.logger
    this.queues = opts.queues
  }

  public async send(message: IngestionQueueMessage): Promise<void> {
    const queue = this.queues[selectQueueShardIndex(message.customerId, this.queues.length)]!
    let lastError: Error | undefined

    for (let attempt = 0; attempt < SEND_RETRIES; attempt++) {
      try {
        await queue.send(message)
        return
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught))
        lastError = error
        this.logger.warn("raw ingestion queue send failed", {
          operation: "raw_ingestion_queue_send",
          attempt: attempt + 1,
          maxAttempts: SEND_RETRIES,
          projectId: message.projectId,
          customerId: message.customerId,
          eventId: message.id,
          idempotencyKey: message.idempotencyKey,
          error_type: error.name,
          error_message: error.message,
        })

        if (attempt < SEND_RETRIES - 1) {
          await sleep(this.baseDelayMs * 2 ** attempt)
        }
      }
    }

    this.logger.error(lastError ?? new Error("raw ingestion queue send failed permanently"), {
      operation: "raw_ingestion_queue_send_permanent",
      projectId: message.projectId,
      customerId: message.customerId,
      eventId: message.id,
      idempotencyKey: message.idempotencyKey,
    })

    throw new Error("Failed to enqueue ingestion event", { cause: lastError })
  }
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return
  }

  await new Promise((resolve) => setTimeout(resolve, ms))
}
