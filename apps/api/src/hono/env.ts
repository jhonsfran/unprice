import type { Analytics } from "@unprice/analytics"
import type { Stats } from "@unprice/analytics/utils"
import type { Database } from "@unprice/db"
import type { Logger, WideEventHelpers, WideEventLogger } from "@unprice/logging"
import type { ApiKeysService } from "@unprice/services/apikey"
import type { Cache } from "@unprice/services/cache"
import type { CustomerService } from "@unprice/services/customers"
import type { Metrics } from "@unprice/services/metrics"
import type { SubscriptionService } from "@unprice/services/subscriptions"
import type { Env } from "~/env"
import type { ApiProjectService } from "~/project"
import type { UsageLimiter } from "~/usagelimiter"

export type ServiceContext = {
  version: string
  usagelimiter: UsageLimiter
  analytics: Analytics
  cache: Cache
  logger: Logger
  metrics: Metrics
  apikey: ApiKeysService
  project: ApiProjectService
  customer: CustomerService
  subscription: SubscriptionService
  db: Database
  wideEventHelpers: WideEventHelpers
}

export type HonoEnv = {
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
    wideEventLogger: WideEventLogger
    wideEventHelpers: WideEventHelpers
  }
}
