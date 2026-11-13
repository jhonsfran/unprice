import type { Database } from "@unprice/db"
import type { WebEventsWriter } from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import type { AnalyticsService, BudgetJournalReader } from "@unprice/services/analytics"
import type { ApiKeysService } from "@unprice/services/apikey"
import type { BillingService } from "@unprice/services/billing"
import type { BudgetCatalogService } from "@unprice/services/budget-catalog"
import type { Cache } from "@unprice/services/cache"
import type { CustomerService } from "@unprice/services/customers"
import type { EntitlementService } from "@unprice/services/entitlements"
import type { EventService } from "@unprice/services/events"
import type { FeatureService } from "@unprice/services/features"
import type { LedgerGateway } from "@unprice/services/ledger"
import type { Metrics } from "@unprice/services/metrics"
import type { PageService } from "@unprice/services/pages"
import type { PlanService } from "@unprice/services/plans"
import type { ProjectService } from "@unprice/services/projects"
import type { RateCardService } from "@unprice/services/rate-cards"
import type { SubscriptionService } from "@unprice/services/subscriptions"
import type { BudgetClient } from "@unprice/services/use-cases"
import type { ExecuteBudgetCommandDeps } from "@unprice/services/use-cases"
import type { WalletService } from "@unprice/services/wallet"
import type { EvlogVariables } from "evlog/hono"
import type { Env } from "~/env"
import type { Stats } from "~/util/stats"

/**
 * Domain services — business logic, properly wired via createServiceContext.
 */
export type DomainServiceContext = {
  /** Web analytics read with Basin SQL. */
  analytics: AnalyticsService
  budgetJournal: BudgetJournalReader
  budgetCatalog: BudgetCatalogService
  customer: CustomerService
  subscription: SubscriptionService
  entitlement: EntitlementService
  plans: PlanService
  features: FeatureService
  events: EventService
  project: ProjectService
  apikey: ApiKeysService
  ledger: LedgerGateway
  wallet: WalletService
  billing: BillingService
  rateCards: RateCardService
  pages: PageService
}

/**
 * Domain service bag set on `c.get("services")`.
 * Infrastructure primitives live on top-level context variables.
 */
export type ServiceContext = DomainServiceContext

export type HonoEnv = EvlogVariables & {
  Bindings: Env
  Variables: {
    isolateId: string
    isolateCreatedAt: number
    requestId: string
    requestStartedAt: number
    performanceStart: number
    unPriceCustomerId?: string
    workspaceId?: string
    projectId?: string
    isInternal?: boolean
    isMain?: boolean
    budgetDeps?: ExecuteBudgetCommandDeps & { budgets: BudgetClient }
    db: Database
    cache: Cache
    logger: Logger
    metrics: Metrics
    /** Web analytics: sign-up rows go to the web_events stream. */
    webEvents: WebEventsWriter
    // biome-ignore lint/suspicious/noExplicitAny: platform-specific promise handler
    waitUntil: (promise: Promise<any>) => void
    services: ServiceContext
    stats: Stats
  }
}
