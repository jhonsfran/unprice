import type { Logger } from "@unprice/logs"
import { createStandaloneRequestLogger } from "@unprice/observability"

interface QueueConsumerEntrypointParams {
  executionCtx: ExecutionContext
  drain?: { flush: () => Promise<void> }
  /** Prefix for the synthetic request id, e.g. "queue" or "reporting-dlq". */
  requestIdPrefix: string
  /** Wide-event `service` field. */
  service: string
  /** Wide-event request path, e.g. "/queues/ingestion/consume". */
  path: string
  /** Wide-event `business.operation` field. */
  operation: string
  /** Optional extra logging on the error path (before the error is re-logged). */
  onError?: (logger: Logger, error: unknown) => void
}

/**
 * Shared wrapper for the queue-consumer worker entrypoints: standalone request
 * logger setup, wide-event context, and the try/catch/finally that emits the
 * request line and flushes the drain. The `consume` callback receives the
 * configured logger and owns building + running the specific consumer.
 */
export async function runQueueConsumerEntrypoint(
  params: QueueConsumerEntrypointParams,
  consume: (logger: Logger) => Promise<void>
): Promise<void> {
  const startedAt = Date.now()
  const batchRequestId = `${params.requestIdPrefix}:${startedAt}`
  const { logger, requestLogger } = createStandaloneRequestLogger(
    { requestId: batchRequestId },
    { flush: params.drain?.flush }
  )

  logger.set({
    service: params.service,
    request: {
      id: batchRequestId,
      timestamp: new Date(startedAt).toISOString(),
      path: params.path,
    },
    cloud: { platform: "cloudflare" },
    business: { operation: params.operation },
  })

  let thrown: unknown

  try {
    await consume(logger)
  } catch (error) {
    thrown = error
    params.onError?.(logger, error)
    logger.error(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    const duration = Math.max(0, Date.now() - startedAt)
    const status = thrown ? 500 : 200

    requestLogger.set({ status, duration, request: { status, duration } })
    requestLogger.emit({ status, duration, request: { status, duration } })

    if (params.drain) {
      params.executionCtx.waitUntil(params.drain.flush())
    }
  }
}
