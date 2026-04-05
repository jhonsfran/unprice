import { type AppLogger, createStandaloneRequestLogger } from "@unprice/observability"
import type { CustomerService } from "@unprice/services/customers"
import type { GrantsManager } from "@unprice/services/entitlements"
import {
  IngestionQueueConsumer,
  type IngestionQueueMessage,
  IngestionService,
} from "@unprice/services/ingestion"
import type { Env } from "~/env"
import { CloudflareEntitlementWindowClient, CloudflareIdempotencyClient } from "./clients"
import { createQueueServices } from "./queue"

export { IngestionService } from "@unprice/services/ingestion"

type CreateIngestionServiceParams = {
  customerService: CustomerService
  env: Pick<Env, "APP_ENV" | "entitlementwindow" | "ingestionidempotency" | "PIPELINE_EVENTS">
  grantsManager: GrantsManager
  logger: AppLogger
  now?: () => number
}

export function createIngestionService(params: CreateIngestionServiceParams): IngestionService {
  return new IngestionService({
    customerService: params.customerService,
    entitlementWindowClient: new CloudflareEntitlementWindowClient(params.env),
    grantsManager: params.grantsManager,
    idempotencyClient: new CloudflareIdempotencyClient(params.env),
    logger: params.logger,
    pipelineEvents: params.env.PIPELINE_EVENTS,
    now: params.now,
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
    customerService: services.customers,
    grantsManager: services.grantsManager,
    logger,
    env,
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
