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
import type { IngestionMessageProcessingResult } from "./interface"
import type { IngestionQueueMessage } from "./message"
import { IngestionMessageOutcomes } from "./message-outcomes"
import { IngestionPreparedMessageProcessor } from "./prepared-message-processor"
import type { IngestionReportingQueueClient } from "./reporting"
import { IngestionReportingDispatcher } from "./reporting-dispatcher"
import { IngestionSubscriptionCatchUp } from "./subscription-catchup"

const noopReportingClient: IngestionReportingQueueClient = {
  send: async () => {},
}

export class IngestionService {
  private readonly customerGroupProcessor: IngestionCustomerGroupProcessor

  constructor(opts: {
    cache: Pick<Cache, "ingestionPreparedGrantContext">
    db?: Database
    entitlementService: EntitlementService
    entitlementWindowClient: EntitlementWindowClient
    enableTestFailureInjection?: boolean
    fanoutWarningThreshold?: number
    reportingClient?: IngestionReportingQueueClient
    logger: Logger
    now?: () => number
    subscriptions?: Pick<
      SubscriptionService,
      "activateWallet" | "getSubscriptionData" | "materializeBillingPeriods" | "renewSubscription"
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
    const subscriptionCatchUp = opts.subscriptions
      ? new IngestionSubscriptionCatchUp({
          logger: opts.logger,
          subscriptions: opts.subscriptions,
        })
      : undefined
    this.customerGroupProcessor = new IngestionCustomerGroupProcessor({
      entitlementContext,
      enableTestFailureInjection: opts.enableTestFailureInjection,
      logger: opts.logger,
      messageOutcomes,
      preparedMessageProcessor,
      reportingDispatcher,
      subscriptionCatchUp,
    })
  }

  public async processCustomerGroup(params: {
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<IngestionMessageProcessingResult[]> {
    return this.customerGroupProcessor.processCustomerGroup(params)
  }
}
