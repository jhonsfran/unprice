import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { createStandaloneRequestLogger } from "@unprice/observability"
import type { Cache } from "@unprice/services/cache"
import type { EntitlementService } from "@unprice/services/entitlements"
import {
  IngestionQueueConsumer,
  type IngestionQueueMessage,
  IngestionService,
} from "@unprice/services/ingestion"
import type { SubscriptionService } from "@unprice/services/subscriptions"
import type { Env } from "~/env"
import { CloudflareEntitlementWindowClient } from "./entitlements/client"
import { createQueueServices } from "./queue"
import { CloudflareReportingQueueClient } from "./reporting/client"

export { IngestionService } from "@unprice/services/ingestion"

type CreateIngestionServiceParams = {
  cache: Pick<Cache, "ingestionPreparedGrantContext">
  db?: Database
  env: Pick<Env, "APP_ENV" | "entitlementwindow" | "INGESTION_REPORTING_QUEUE">
  entitlementService: EntitlementService
  logger: Logger
  now?: () => number
  subscriptionService?: Pick<
    SubscriptionService,
    "activateWallet" | "getSubscriptionData" | "renewSubscription"
  >
}

export function createIngestionService(params: CreateIngestionServiceParams): IngestionService {
  return new IngestionService({
    cache: params.cache,
    db: params.db,
    entitlementService: params.entitlementService,
    entitlementWindowClient: new CloudflareEntitlementWindowClient(params.env),
    reportingClient: new CloudflareReportingQueueClient(params.env),
    logger: params.logger,
    now: params.now,
    subscriptions: params.subscriptionService,
  })
}

export async function consumeIngestionBatch(
  batch: MessageBatch<IngestionQueueMessage>,
  env: Env,
  executionCtx: ExecutionContext,
  drain?: { flush: () => Promise<void> }
): Promise<void> {
  const batchRequestId = `queue:${Date.now()}`
  const startedAt = Date.now()
  const { logger, requestLogger } = createStandaloneRequestLogger(
    { requestId: batchRequestId },
    { flush: drain?.flush }
  )

  logger.set({
    service: "ingestion_queue",
    request: {
      id: batchRequestId,
      timestamp: new Date(startedAt).toISOString(),
      path: "/queues/ingestion/consume",
    },
    cloud: { platform: "cloudflare" },
    business: { operation: "consume_batch" },
  })

  const services = createQueueServices({
    env,
    executionCtx,
    logger,
  })

  const service = createIngestionService({
    cache: services.cache,
    db: services.db,
    entitlementService: services.entitlements,
    subscriptionService: services.subscriptions,
    logger,
    env,
  })

  const consumer = new IngestionQueueConsumer({
    logger,
    processor: service,
  })

  let thrown: unknown

  try {
    await consumer.consumeBatch(batch)
  } catch (error) {
    thrown = error
    logger.error(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    const duration = Math.max(0, Date.now() - startedAt)
    const status = thrown ? 500 : 200

    requestLogger.set({ status, duration, request: { status, duration } })
    requestLogger.emit({ status, duration, request: { status, duration } })

    if (drain) {
      executionCtx.waitUntil(drain.flush())
    }
  }
}
