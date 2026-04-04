import { CloudflareStore } from "@unkey/cache/stores"
import { Analytics } from "@unprice/analytics"
import { createConnection } from "@unprice/db"
import { newId } from "@unprice/db/utils"
import { shouldEmitMetrics } from "@unprice/observability/env"
import { ApiKeysService } from "@unprice/services/apikey"
import { CacheService } from "@unprice/services/cache"
import { createServiceContext } from "@unprice/services/context"
import { LogdrainMetrics, NoopMetrics } from "@unprice/services/metrics"
import type { MiddlewareHandler } from "hono"
import type { HonoEnv } from "~/hono/env"
import { createApiLogger } from "~/observability"
import { ApiProjectService } from "~/project"

import { CloudflareEntitlementWindowClient, CloudflareIdempotencyClient } from "~/ingestion/clients"
import { IngestionService } from "~/ingestion/service"

/**
 * These maps persist between worker executions and are used for caching
 */
const hashCache = new Map()

/**
 * workerId and isolateCreatedAt are used to track the lifetime of the worker
 * and are set once when the worker is first initialized.
 *
 * subsequent requests will use the same workerId and isolateCreatedAt
 */
let isolateId: string | undefined = undefined
let isolateCreatedAt: number | undefined = undefined

/**
 * Initialize all services.
 *
 * Call this once before any hono handlers run.
 */
export function init(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const stats = c.get("stats")

    if (!isolateId) {
      isolateId = newId("isolate")
      isolateCreatedAt = Date.now()
    }

    if (!isolateCreatedAt) {
      isolateCreatedAt = Date.now()
    }

    const inboundUnpriceRequestId = c.req.header("unprice-request-id")?.trim()
    const inboundXRequestId = c.req.header("x-request-id")?.trim()
    const inboundVercelRequestId = c.req.header("x-vercel-id")?.trim()
    const upstreamRequestId = inboundUnpriceRequestId || inboundXRequestId || inboundVercelRequestId
    const requestId = newId("request")

    const requestStartedAt = Date.now()
    const performanceStart = Date.now()

    c.set("isolateId", isolateId)
    c.set("isolateCreatedAt", isolateCreatedAt)
    c.set("requestId", requestId)
    c.set("requestStartedAt", requestStartedAt)
    c.set("performanceStart", performanceStart)

    const emitMetrics = shouldEmitMetrics(c.env)
    const logger = createApiLogger(c.get("log"), requestId)
    const requestUrl = new URL(c.req.url)
    const protocol = requestUrl.protocol === "https:" ? "https" : "http"

    logger.set({
      request: {
        id: requestId,
        parent_id: upstreamRequestId,
        timestamp: new Date().toISOString(),
        method: c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS",
        path: c.req.path,
        referer: c.req.header("referer"),
        host: c.req.header("host") ?? requestUrl.host,
        protocol,
        query: requestUrl.search ? requestUrl.search.slice(1) : undefined,
      },
      cloud: {
        platform: "cloudflare",
        isolate_id: isolateId,
        region: stats.region,
      },
      geo: {
        colo: stats.colo,
        country: stats.country,
        continent: stats.continent,
        city: stats.city,
        region: stats.region,
        ip: stats.ip,
        ua: stats.ua,
        source: stats.source,
      },
    })

    const metrics = emitMetrics
      ? new LogdrainMetrics({
          requestId,
          environment: c.env.APP_ENV,
          logger,
          service: "api",
          colo: stats.colo,
          country: stats.country,
          continent: stats.continent,
          sampleRate: 1,
        })
      : new NoopMetrics()

    const cacheService = new CacheService(
      {
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        waitUntil: (promise: Promise<any>) => c.executionCtx.waitUntil(promise),
      },
      metrics,
      emitMetrics
    )

    const cloudflareCacheStore =
      c.env.CLOUDFLARE_ZONE_ID &&
      c.env.CLOUDFLARE_API_TOKEN &&
      c.env.CLOUDFLARE_CACHE_DOMAIN &&
      c.env.CLOUDFLARE_ZONE_ID !== "" &&
      c.env.CLOUDFLARE_API_TOKEN !== "" &&
      c.env.CLOUDFLARE_CACHE_DOMAIN !== ""
        ? new CloudflareStore({
            cloudflareApiKey: c.env.CLOUDFLARE_API_TOKEN,
            zoneId: c.env.CLOUDFLARE_ZONE_ID,
            domain: c.env.CLOUDFLARE_CACHE_DOMAIN,
            cacheBuster: "v2",
          })
        : undefined

    const stores = []

    // push the cloudflare store first to hit it first
    if (cloudflareCacheStore) {
      stores.push(cloudflareCacheStore)
    }

    // register the cloudflare store if it is configured
    cacheService.init(stores)

    const cache = cacheService.getCache()

    const db = createConnection({
      env: c.env.APP_ENV,
      primaryDatabaseUrl: c.env.DATABASE_URL,
      read1DatabaseUrl: c.env.DATABASE_READ1_URL,
      read2DatabaseUrl: c.env.DATABASE_READ2_URL,
      logger: c.env.DRIZZLE_LOG.toString() === "true",
      singleton: false,
    })

    const analytics = new Analytics({
      emit: true,
      tinybirdToken: c.env.TINYBIRD_TOKEN,
      tinybirdUrl: c.env.TINYBIRD_URL,
      logger,
    })

    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const waitUntil = (promise: Promise<any>) => c.executionCtx.waitUntil(promise)

    // Build the shared service graph from infrastructure deps.
    const svcCtx = createServiceContext({
      db,
      logger,
      analytics,
      waitUntil,
      cache,
      metrics,
    })

    const project = new ApiProjectService({
      cache,
      analytics,
      logger,
      metrics,
      waitUntil,
      db,
      requestId,
    })

    const apikey = new ApiKeysService({
      cache,
      analytics,
      logger,
      metrics,
      db,
      waitUntil,
      hashCache,
    })

    const ingestion = new IngestionService({
      customerService: svcCtx.customers,
      entitlementWindowClient: new CloudflareEntitlementWindowClient(c.env),
      grantsManager: svcCtx.grantsManager,
      idempotencyClient: new CloudflareIdempotencyClient(c.env),
      logger,
      pipelineEvents: c.env.PIPELINE_EVENTS,
    })

    c.set("services", {
      version: "1.0.0",
      subscription: svcCtx.subscriptions,
      entitlement: svcCtx.entitlements,
      analytics,
      ingestion,
      project,
      cache,
      logger,
      metrics,
      apikey,
      db,
      customer: svcCtx.customers,
      plans: svcCtx.plans,
    })

    metrics.emit({
      metric: "metric.init",
      duration: Date.now() - performanceStart,
    })

    await next()
  }
}
