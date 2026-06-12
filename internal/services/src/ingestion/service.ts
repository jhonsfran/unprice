import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import type { Cache } from "../cache/service"
import type { EntitlementService } from "../entitlements/service"
import type { SubscriptionService } from "../subscriptions/service"
import { IngestionCustomerGroupProcessor } from "./customer-group-processor"
import { IngestionEntitlementContextLoader } from "./entitlement-context"
import { IngestionEntitlementRouter } from "./entitlement-routing"
import {
  EntitlementWindowApplier,
  type EntitlementWindowClient,
} from "./entitlement-window-applier"
import { IngestionFeatureVerifier } from "./feature-verification"
import type {
  FeatureVerificationResult,
  IngestionMessageProcessingResult,
  IngestionSyncResult,
} from "./interface"
import type { IngestionQueueMessage } from "./message"
import { IngestionMessageOutcomes } from "./message-outcomes"
import { IngestionPreparedMessageProcessor } from "./prepared-message-processor"
import type { IngestionReportingQueueClient } from "./reporting"
import { IngestionReportingDispatcher } from "./reporting-dispatcher"
import { IngestionSubscriptionCatchUp } from "./subscription-catchup"
import { IngestionSyncProcessor } from "./sync-processor"

const noopReportingClient: IngestionReportingQueueClient = {
  send: async () => {},
}

export class IngestionService {
  private readonly customerGroupProcessor: IngestionCustomerGroupProcessor
  private readonly featureVerifier: IngestionFeatureVerifier
  private readonly syncProcessor: IngestionSyncProcessor

  constructor(opts: {
    cache: Pick<Cache, "ingestionPreparedGrantContext">
    db?: Database
    entitlementService: EntitlementService
    entitlementWindowClient: EntitlementWindowClient
    fanoutWarningThreshold?: number
    reportingClient?: IngestionReportingQueueClient
    logger: Logger
    now?: () => number
    subscriptions?: Pick<
      SubscriptionService,
      "activateWallet" | "getSubscriptionData" | "renewSubscription"
    >
  }) {
    const now = opts.now ?? (() => Date.now())
    const entitlementWindowApplier = new EntitlementWindowApplier(opts.entitlementWindowClient)
    const entitlementRouter = new IngestionEntitlementRouter({
      fanoutWarningThreshold: opts.fanoutWarningThreshold,
      logger: opts.logger,
    })
    const entitlementContext = new IngestionEntitlementContextLoader({
      cache: opts.cache,
      db: opts.db,
      entitlementService: opts.entitlementService,
      logger: opts.logger,
    })
    this.featureVerifier = new IngestionFeatureVerifier({
      entitlementContext,
      entitlementWindowClient: opts.entitlementWindowClient,
      logger: opts.logger,
    })
    const messageOutcomes = new IngestionMessageOutcomes({
      logger: opts.logger,
      now,
    })
    const preparedMessageProcessor = new IngestionPreparedMessageProcessor({
      entitlementRouter,
      entitlementWindowApplier,
      logger: opts.logger,
      messageOutcomes,
    })
    const reportingDispatcher = new IngestionReportingDispatcher({
      logger: opts.logger,
      now,
      reportingClient: opts.reportingClient ?? noopReportingClient,
    })
    this.syncProcessor = new IngestionSyncProcessor({
      entitlementContext,
      entitlementRouter,
      entitlementWindowApplier,
      messageOutcomes,
      now,
      reportingDispatcher,
    })
    const subscriptionCatchUp = opts.subscriptions
      ? new IngestionSubscriptionCatchUp({
          logger: opts.logger,
          subscriptions: opts.subscriptions,
        })
      : undefined
    this.customerGroupProcessor = new IngestionCustomerGroupProcessor({
      entitlementContext,
      logger: opts.logger,
      messageOutcomes,
      preparedMessageProcessor,
      reportingDispatcher,
      subscriptionCatchUp,
    })
  }

  public async ingestFeatureSync(params: {
    featureSlug: string
    message: IngestionQueueMessage
  }): Promise<IngestionSyncResult> {
    return this.syncProcessor.ingestFeatureSync(params)
  }

  public async verifyFeatureStatus(params: {
    customerId: string
    featureSlug: string
    projectId: string
    timestamp: number
  }): Promise<FeatureVerificationResult> {
    return this.featureVerifier.verifyFeatureStatus(params)
  }

  public async processCustomerGroup(params: {
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<IngestionMessageProcessingResult[]> {
    return this.customerGroupProcessor.processCustomerGroup(params)
  }
}
