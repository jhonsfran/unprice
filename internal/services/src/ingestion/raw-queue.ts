import type { IngestionQueueMessage } from "./message"

/**
 * Producer port for raw ingestion; adapters own shard selection and at-least-once send retries.
 */
export interface RawIngestionQueueClient {
  send(message: IngestionQueueMessage): Promise<void>
}
