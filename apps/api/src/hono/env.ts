import type { Analytics } from "@unprice/analytics"
import type { Stats } from "@unprice/analytics/utils"
import type { Database } from "@unprice/db"
import type { AppLogger } from "@unprice/observability"
import type { ApiKeysService } from "@unprice/services/apikey"
import type { Cache } from "@unprice/services/cache"
import type { CustomerService } from "@unprice/services/customers"
import type { EntitlementService } from "@unprice/services/entitlements"
import type { LedgerGateway } from "@unprice/services/ledger"
import type { Metrics } from "@unprice/services/metrics"
import type { PlanService } from "@unprice/services/plans"
import type { ProjectService } from "@unprice/services/projects"
import type { SubscriptionService } from "@unprice/services/subscriptions"
import type { WalletService } from "@unprice/services/wallet"
import type { EvlogVariables } from "evlog/hono"
import type { Env } from "~/env"
import type { IngestionService } from "~/ingestion/service"

/**
 * Domain services — business logic, properly wired via createServiceContext.
 */
export type DomainServiceContext = {
  customer: CustomerService
  subscription: SubscriptionService
  entitlement: EntitlementService
  plans: PlanService
  ingestion: IngestionService
  project: ProjectService
  apikey: ApiKeysService
  ledger: LedgerGateway
  wallet: WalletService
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
    db: Database
    cache: Cache
    logger: AppLogger
    metrics: Metrics
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: platform-specific promise handler
    waitUntil: (promise: Promise<any>) => void
    services: ServiceContext
    stats: Stats
  }
}
