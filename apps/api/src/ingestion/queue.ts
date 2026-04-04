import { CloudflareStore } from "@unkey/cache/stores"
import { Analytics } from "@unprice/analytics"
import { createConnection } from "@unprice/db"
import type { AppLogger } from "@unprice/observability"
import { CacheService } from "@unprice/services/cache"
import { createServiceContext } from "@unprice/services/context"
import type { ServiceContext } from "@unprice/services/context"
import { NoopMetrics } from "@unprice/services/metrics"
import type { Env } from "~/env"

export function createQueueServices(params: {
  env: Env
  executionCtx: ExecutionContext
  logger: AppLogger
}): Pick<ServiceContext, "customers" | "grantsManager"> {
  const db = createConnection({
    env: params.env.APP_ENV,
    primaryDatabaseUrl: params.env.DATABASE_URL,
    read1DatabaseUrl: params.env.DATABASE_READ1_URL,
    read2DatabaseUrl: params.env.DATABASE_READ2_URL,
    logger: params.env.DRIZZLE_LOG.toString() === "true",
    singleton: false,
  })
  const metrics = new NoopMetrics()
  const waitUntil = (promise: Promise<unknown>) => params.executionCtx.waitUntil(promise)
  const cacheService = new CacheService(
    {
      waitUntil,
    },
    metrics,
    false
  )
  const cloudflareCacheStore =
    params.env.CLOUDFLARE_ZONE_ID &&
    params.env.CLOUDFLARE_API_TOKEN &&
    params.env.CLOUDFLARE_CACHE_DOMAIN &&
    params.env.CLOUDFLARE_ZONE_ID !== "" &&
    params.env.CLOUDFLARE_API_TOKEN !== "" &&
    params.env.CLOUDFLARE_CACHE_DOMAIN !== ""
      ? new CloudflareStore({
          cloudflareApiKey: params.env.CLOUDFLARE_API_TOKEN,
          zoneId: params.env.CLOUDFLARE_ZONE_ID,
          domain: params.env.CLOUDFLARE_CACHE_DOMAIN,
          cacheBuster: "v2",
        })
      : undefined

  cacheService.init(cloudflareCacheStore ? [cloudflareCacheStore] : [])
  const cache = cacheService.getCache()
  const analytics = new Analytics({
    emit: true,
    tinybirdToken: params.env.TINYBIRD_TOKEN,
    tinybirdUrl: params.env.TINYBIRD_URL,
    logger: params.logger,
  })

  const svcCtx = createServiceContext({
    db,
    logger: params.logger,
    analytics,
    waitUntil,
    cache,
    metrics,
  })

  return {
    customers: svcCtx.customers,
    grantsManager: svcCtx.grantsManager,
  }
}
