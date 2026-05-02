import { type AppLogger, createStandaloneRequestLogger } from "@unprice/observability"
import type { Cache } from "@unprice/services/cache"
import type { EntitlementService } from "@unprice/services/entitlements"
import {
  IngestionQueueConsumer,
  type IngestionQueueMessage,
  IngestionService,
} from "@unprice/services/ingestion"
import type { Env } from "~/env"
import { CloudflareAuditClient } from "./audit/client"
import { CloudflareEntitlementWindowClient } from "./entitlements/client"
import { createQueueServices } from "./queue"

export { IngestionService } from "@unprice/services/ingestion"

type CreateIngestionServiceParams = {
  cache: Pick<Cache, "ingestionPreparedGrantContext">
  env: Pick<Env, "APP_ENV" | "entitlementwindow" | "ingestionaudit">
  entitlementService: EntitlementService
  logger: AppLogger
  now?: () => number
  waitUntil: (promise: Promise<unknown>) => void
}

export function createIngestionService(params: CreateIngestionServiceParams): IngestionService {
  return new IngestionService({
    cache: params.cache,
    entitlementService: params.entitlementService,
    entitlementWindowClient: new CloudflareEntitlementWindowClient(params.env),
    auditClient: new CloudflareAuditClient(params.env),
    logger: params.logger,
    now: params.now,
    waitUntil: params.waitUntil,
  })
}

export async function consumeIngestionBatch(
  batch: MessageBatch<IngestionQueueMessage>,
  env: Env,
  executionCtx: ExecutionContext
): Promise<void> {
  const batchRequestId = `queue:${Date.now()}`
  const { logger } = createStandaloneRequestLogger({
    requestId: batchRequestId,
  })

  logger.set({
    service: "api",
    request: {
      id: batchRequestId,
    },
    cloud: {
      platform: "cloudflare",
    },
    business: {
      operation: "raw_ingestion_queue_consume",
    },
  })

  const services = createQueueServices({
    env,
    executionCtx,
    logger,
  })

  const service = createIngestionService({
    cache: services.cache,
    entitlementService: services.entitlements,
    logger,
    env,
    waitUntil: executionCtx.waitUntil.bind(executionCtx),
  })

  const consumer = new IngestionQueueConsumer({
    logger,
    processor: service,
  })

  await consumer.consumeBatch(batch)

  await logger.flush().catch((error: Error) => {
    logger.emit("error", "Failed to flush ingestion queue logger", {
      error: error.message,
    })
  })
}
