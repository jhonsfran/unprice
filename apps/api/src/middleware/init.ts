import { CloudflareStore } from "@unkey/cache/stores"
import { Analytics } from "@unprice/analytics"
import { createConnection } from "@unprice/db"
import { newId } from "@unprice/db/utils"
import {
  AxiomLogger,
  ConsoleLogger,
  createWideEventHelpers,
  createWideEventLogger,
} from "@unprice/logging"
import { ApiKeysService } from "@unprice/services/apikey"
import { CacheService } from "@unprice/services/cache"
import { CustomerService } from "@unprice/services/customers"
import { LogdrainMetrics, NoopMetrics } from "@unprice/services/metrics"
import type { MiddlewareHandler } from "hono"
import type { HonoEnv } from "~/hono/env"
import { ApiProjectService } from "~/project"
import { UsageLimiterService } from "~/usagelimiter/service"

import { SubscriptionService } from "@unprice/services/subscriptions"
import { NoopUsageLimiter } from "~/usagelimiter/noop"

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

    const requestId =
      c.req.header("unprice-request-id") ||
      c.req.header("x-request-id") ||
      c.req.header("x-vercel-id") ||
      newId("request")

    const requestStartedAt = Date.now()
    const performanceStart = performance.now()
    // start a new timer

    c.set("isolateId", isolateId)
    c.set("isolateCreatedAt", isolateCreatedAt)
    c.set("requestId", requestId)
    c.set("requestStartedAt", requestStartedAt)
    c.set("performanceStart", performanceStart)

    const emitMetrics = c.env.EMIT_METRICS_LOGS.toString() === "true"

    const logger = emitMetrics
      ? new AxiomLogger({
          apiKey: c.env.AXIOM_API_TOKEN,
          dataset: c.env.AXIOM_DATASET,
          requestId,
          environment: c.env.NODE_ENV,
          service: "api",
          logLevel: c.env.VERCEL_ENV === "production" ? "warn" : "info",
          defaultFields: {
            isolateId,
            isolateCreatedAt,
            requestId,
            requestStartedAt,
            performanceStart,
            workspaceId: c.get("workspaceId"),
            projectId: c.get("projectId"),
            location: stats.colo,
            userAgent: stats.ua,
            path: c.req.path,
            region: stats.region,
            country: stats.country,
            source: stats.source,
            ip: stats.ip,
            pathname: c.req.path,
          },
        })
      : new ConsoleLogger({
          requestId,
          environment: c.env.NODE_ENV,
          service: "api",
          logLevel: c.env.VERCEL_ENV === "production" ? "warn" : "info",
          defaultFields: {
            isolateId,
            isolateCreatedAt,
            requestId,
            requestStartedAt,
            performanceStart,
            workspaceId: c.get("workspaceId"),
            projectId: c.get("projectId"),
            location: stats.colo,
            userAgent: stats.ua,
            path: c.req.path,
            region: stats.region,
            country: stats.country,
            source: stats.source,
            ip: stats.ip,
            pathname: c.req.path,
            version: c.env.VERSION,
          },
        })

    const wideEventLogger = createWideEventLogger({
      "service.name": "api",
      "service.version": c.env.VERSION,
      "service.environment": c.env.NODE_ENV,
      sampleRate: c.env.NODE_ENV === "production" ? 0.1 : 1,
      emitter: (level, message, event) => logger.emit(level, message, event),
    })

    const wideEventHelpers = createWideEventHelpers(wideEventLogger)

    // Pass wideEventLogger through context for request-scoped access
    c.set("wideEventLogger", wideEventLogger)
    c.set("wideEventHelpers", wideEventHelpers)

    const metrics = emitMetrics
      ? new LogdrainMetrics({
          requestId,
          environment: c.env.NODE_ENV,
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
      env: c.env.NODE_ENV,
      primaryDatabaseUrl: c.env.DATABASE_URL,
      read1DatabaseUrl: c.env.DATABASE_READ1_URL,
      read2DatabaseUrl: c.env.DATABASE_READ2_URL,
      logger: c.env.DRIZZLE_LOG.toString() === "true",
      singleton: false,
    })

    const analytics = new Analytics({
      emit: c.env.EMIT_ANALYTICS.toString() === "true",
      tinybirdToken: c.env.TINYBIRD_TOKEN,
      tinybirdUrl: c.env.TINYBIRD_URL,
      logger,
    })

    const customer = new CustomerService({
      logger,
      analytics,
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      waitUntil: (promise: Promise<any>) => c.executionCtx.waitUntil(promise),
      cache,
      metrics,
      db,
    })

    const subscription = new SubscriptionService({
      logger,
      analytics,
      cache,
      db,
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      waitUntil: (promise: Promise<any>) => c.executionCtx.waitUntil(promise),
      metrics,
    })

    const usageLimiterService = c.env.usagelimit
      ? new UsageLimiterService({
          namespace: c.env.usagelimit,
          projectNamespace: c.env.projectdo,
          requestId,
          logger,
          metrics,
          analytics,
          cache,
          db,
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
          waitUntil: (promise: Promise<any>) => c.executionCtx.waitUntil(promise),
          customer,
          stats: c.get("stats"),
          hashCache,
        })
      : new NoopUsageLimiter()

    const project = new ApiProjectService({
      cache,
      analytics,
      logger,
      metrics,
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      waitUntil: (promise: Promise<any>) => c.executionCtx.waitUntil(promise),
      db,
      requestId,
    })

    const apikey = new ApiKeysService({
      cache,
      analytics,
      logger,
      metrics,
      db,
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      waitUntil: (promise: Promise<any>) => c.executionCtx.waitUntil(promise),
      hashCache,
    })

    c.set("services", {
      version: "1.0.0",
      usagelimiter: usageLimiterService,
      subscription,
      analytics,
      project,
      cache,
      logger,
      metrics,
      apikey,
      db,
      customer,
      wideEventHelpers,
    })

    // Run within the wide event context so add() and emit() see the same store
    await wideEventLogger.runAsync(async () => {
      wideEventLogger.addMany({
        request: {
          id: requestId,
          timestamp: new Date().toISOString(),
          method: c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS",
          path: c.req.path,
          referer: c.req.header("referer"),
          host: c.req.header("host"),
          protocol: c.req.header("protocol") as "http" | "https" | undefined,
          query: JSON.stringify(c.req.query()),
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

      metrics.emit({
        metric: "metric.init",
        duration: performance.now() - performanceStart,
      })

      await next()
    })
  }
}
