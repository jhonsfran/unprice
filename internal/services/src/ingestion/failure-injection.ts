import type { IngestionQueueMessage } from "./message"

const RAW_PROCESSING_FAILURE_REQUEST_ID_PREFIX = "test:raw_ingestion_queue_processing_failed:"

export function markRawProcessingFailureTestRequestId(requestId: string): string {
  return `${RAW_PROCESSING_FAILURE_REQUEST_ID_PREFIX}${requestId}`
}

export function hasRawProcessingFailureTestMarker(messages: IngestionQueueMessage[]): boolean {
  return messages.some((message) =>
    message.requestId.startsWith(RAW_PROCESSING_FAILURE_REQUEST_ID_PREFIX)
  )
}
