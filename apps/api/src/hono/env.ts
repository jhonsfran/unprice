import type { Analytics } from "@unprice/analytics"
import type { Stats } from "@unprice/analytics/utils"
import type { Database } from "@unprice/db"
import type { AppLogger } from "@unprice/observability"
import type { ApiKeysService } from "@unprice/services/apikey"
import type { Cache } from "@unprice/services/cache"
import type { CustomerService } from "@unprice/services/customers"
import type { EntitlementService } from "@unprice/services/entitlements"
import type { Metrics } from "@unprice/services/metrics"
import type { PlanService } from "@unprice/services/plans"
import type { SubscriptionService } from "@unprice/services/subscriptions"
import type { EvlogVariables } from "evlog/hono"
import type { Env } from "~/env"
import type { IngestionService } from "~/ingestion/service"
import type { ApiProjectService } from "~/project"

/**
 * Infrastructure dependencies — shared runtime primitives.
 * Routes should prefer domain services over these when possible.
 */
export type InfraContext = {
  db: Database
  cache: Cache
  logger: AppLogger
  metrics: Metrics
  analytics: Analytics
}

/**
 * Domain services — business logic, properly wired via createServiceContext.
 */
export type DomainServiceContext = {
  customer: CustomerService
  subscription: SubscriptionService
  entitlement: EntitlementService
  plans: PlanService
  ingestion: IngestionService
  project: ApiProjectService
  apikey: ApiKeysService
}

/**
 * The full service bag set on `c.get("services")`.
 * Combines infra + domain + metadata.
 */
export type ServiceContext = InfraContext &
  DomainServiceContext & {
    version: string
  }

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
    services: ServiceContext
    stats: Stats
  }
}
