import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import type { Cache } from "@unprice/services/cache"
import type { EntitlementService } from "@unprice/services/entitlements"
import {
  IngestionDlqConsumer,
  IngestionQueueConsumer,
  IngestionReportingDispatcher,
  IngestionService,
} from "@unprice/services/ingestion"
import type { SubscriptionService } from "@unprice/services/subscriptions"
import type { Env } from "~/env"
import { CloudflareEntitlementWindowClient } from "./entitlements/client"
import { createQueueServices } from "./queue"
import { runQueueConsumerEntrypoint } from "./queue-entrypoint"
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
    "activateWallet" | "getSubscriptionData" | "materializeBillingPeriods" | "renewSubscription"
  >
}

export function createIngestionService(params: CreateIngestionServiceParams): IngestionService {
  return new IngestionService({
    cache: params.cache,
    db: params.db,
    enableTestFailureInjection: params.env.APP_ENV !== "production",
    entitlementService: params.entitlementService,
    entitlementWindowClient: new CloudflareEntitlementWindowClient(params.env),
    reportingClient: new CloudflareReportingQueueClient(params.env),
    logger: params.logger,
    now: params.now,
    subscriptions: params.subscriptionService,
  })
}

export async function consumeIngestionBatch(
  batch: MessageBatch<unknown>,
  env: Env,
  executionCtx: ExecutionContext,
  drain?: { flush: () => Promise<void> }
): Promise<void> {
  await runQueueConsumerEntrypoint(
    {
      executionCtx,
      drain,
      requestIdPrefix: "queue",
      service: "ingestion_queue",
      path: "/queues/ingestion/consume",
      operation: "consume_batch",
    },
    async (logger) => {
      const services = createQueueServices({ env, executionCtx, logger })

      const service = createIngestionService({
        cache: services.cache,
        db: services.db,
        entitlementService: services.entitlements,
        subscriptionService: services.subscriptions,
        logger,
        env,
      })

      const consumer = new IngestionQueueConsumer({ logger, processor: service })
      await consumer.consumeBatch(batch)
    }
  )
}

export async function consumeIngestionDlqBatch(
  batch: MessageBatch<unknown>,
  env: Env,
  executionCtx: ExecutionContext,
  drain?: { flush: () => Promise<void> }
): Promise<void> {
  await runQueueConsumerEntrypoint(
    {
      executionCtx,
      drain,
      requestIdPrefix: "dlq",
      service: "ingestion_dlq",
      path: "/queues/ingestion-dlq/consume",
      operation: "consume_dlq_batch",
    },
    async (logger) => {
      const consumer = new IngestionDlqConsumer({
        logger,
        now: Date.now,
        reportingDispatcher: new IngestionReportingDispatcher({
          logger,
          now: Date.now,
          reportingClient: new CloudflareReportingQueueClient(env),
        }),
      })
      await consumer.consumeBatch(batch)
    }
  )
}
