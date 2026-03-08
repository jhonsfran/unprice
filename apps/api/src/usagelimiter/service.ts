import { env } from "cloudflare:workers"
import type { Analytics } from "@unprice/analytics"
import type { Stats } from "@unprice/analytics/utils"
import type { Database } from "@unprice/db"
import type {
  MinimalEntitlement,
  ReportUsageRequest,
  ReportUsageResult,
  SubscriptionStatus,
  VerificationResult,
  VerifyRequest,
} from "@unprice/db/validators"
import type { CurrentUsage } from "@unprice/db/validators"
import { type BaseError, Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { Cache, CacheNamespaces } from "@unprice/services/cache"
import type { CustomerService } from "@unprice/services/customers"
import type { UnPriceCustomerError } from "@unprice/services/customers"
import {
  EntitlementService,
  MemoryEntitlementStorageProvider,
} from "@unprice/services/entitlements"
import type { Metrics } from "@unprice/services/metrics"
import type { DurableObjectProject } from "~/project/do"
import type { DurableObjectUsagelimiter } from "./do"
import type {
  BufferMetricsResponse,
  GetEntitlementsRequest,
  GetUsageRequest,
  UsageLimiter,
} from "./interface"

// you would understand entitlements service if you think about it as feature flag system
// it's totally separated from billing system and you can give entitlements to customers
// without affecting the billing.
export class UsageLimiterService implements UsageLimiter {
  private readonly namespace: DurableObjectNamespace<DurableObjectUsagelimiter>
  private readonly projectNamespace: DurableObjectNamespace<DurableObjectProject>
  private readonly logger: Logger
  private readonly metrics: Metrics
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly db: Database
  private readonly customerService: CustomerService
  private readonly entitlementService: EntitlementService
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private readonly stats: Stats
  private readonly requestId: string
  private hashCache: Map<string, string>

  constructor(opts: {
    namespace: DurableObjectNamespace<DurableObjectUsagelimiter>
    projectNamespace: DurableObjectNamespace<DurableObjectProject>
    requestId: string
    domain?: string
    logger: Logger
    metrics: Metrics
    analytics: Analytics
    hashCache: Map<string, string>
    cache: Cache
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    db: Database
    customer: CustomerService
    stats: Stats
  }) {
    this.namespace = opts.namespace
    this.logger = opts.logger
    this.metrics = opts.metrics
    this.analytics = opts.analytics
    this.cache = opts.cache
    this.db = opts.db
    this.waitUntil = opts.waitUntil
    this.customerService = opts.customer
    this.projectNamespace = opts.projectNamespace
    this.stats = opts.stats
    this.requestId = opts.requestId
    this.hashCache = opts.hashCache

    // we don't need storage for this so we don't need to call the DO
    // instead we use the entitlement service
    this.entitlementService = new EntitlementService({
      db: this.db,
      storage: new MemoryEntitlementStorageProvider({ logger: this.logger }), // we don't need storage but we need to pass it to the service
      logger: this.logger,
      analytics: this.analytics,
      waitUntil: this.waitUntil,
      cache: this.cache,
      metrics: this.metrics,
      config: {
        revalidateInterval:
          env.APP_ENV === "development"
            ? 30000 // 30 seconds
            : 1000 * 60 * 60 * 24, // 24 hours
      },
    })
  }

  // in memory cache with size and TTL limits
  // kid of hard to reach the limit as cloudflare can hit others isolates
  // but just in case we limit it to 1000 entries
  private updateCache(key: string, result: VerificationResult) {
    if (env.APP_ENV === "production" && !result.allowed) {
      // enforce max size - remove oldest entry if at limit
      if (this.hashCache.size >= 1000) {
        // remove first (oldest) entry
        const firstKey = this.hashCache.keys().next().value
        if (firstKey) {
          this.hashCache.delete(firstKey)
        }
      }

      this.hashCache.set(key, JSON.stringify(result))
    }
  }

  // for EU countries we have to keep the stub in the EU namespace
  private getStub(
    name: string,
    locationHint?: DurableObjectLocationHint
  ): DurableObjectStub<DurableObjectUsagelimiter> {
    // jurisdiction is only available in production
    if (this.stats.isEUCountry && env.APP_ENV === "production") {
      const euSubnamespace = this.namespace.jurisdiction("eu")
      const euStub = euSubnamespace.get(euSubnamespace.idFromName(name), {
        locationHint,
      })

      return euStub
    }

    return this.namespace.get(this.namespace.idFromName(name), {
      locationHint,
    })
  }

  private getDurableObjectCustomerId(customerId: string, projectId: string): string {
    // later on we can shard this by customer and feature slug if needed
    // preview environments copy production data so we need to differentiate between them
    return `${env.APP_ENV}:${projectId}:${customerId}`
  }

  // Timeout for DO calls before falling back to cached state
  private static readonly DO_TIMEOUT_MS = 5000

  /**
   * Wraps a promise with a timeout. If the promise doesn't resolve within
   * the specified time, it rejects with a timeout error.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms)
    })

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId)
    })
  }

  /**
   * Builds a degraded verification response from cached entitlement state.
   * Used when DO is unavailable but we have cached data to fall back to.
   */
  private buildDegradedVerifyResponse(
    cachedEntitlement: {
      limit?: number | null
      featureType?: string
      meter?: { usage?: string }
    },
    requestedUsage?: number,
    reason?: string
  ): VerificationResult {
    const limit = cachedEntitlement.limit ?? undefined
    const currentUsage = Number(cachedEntitlement.meter?.usage ?? 0)
    const remaining = limit ? Math.max(0, limit - currentUsage) : undefined

    // Use cached state to determine if request would be allowed
    const wouldBeAllowed =
      !limit || (requestedUsage ? currentUsage + requestedUsage <= limit : true)

    return {
      allowed: wouldBeAllowed,
      degraded: true,
      degradedReason: reason ?? "DO_UNAVAILABLE_USING_CACHED_STATE",
      usage: currentUsage,
      limit,
      remaining,
      featureType: cachedEntitlement.featureType as VerificationResult["featureType"],
      message: wouldBeAllowed ? "Access granted (cached state)" : "Limit exceeded (cached state)",
      deniedReason: wouldBeAllowed ? undefined : "LIMIT_EXCEEDED",
    }
  }

  private shouldRunProbabilisticVerify(data: VerifyRequest): boolean {
    const sampleRate = env.APP_ENV === "production" ? 0.05 : 1
    if (sampleRate <= 0) return false

    const seed = `${data.projectId}:${data.customerId}:${data.featureSlug}:${data.requestId}`
    let hash = 0
    for (let i = 0; i < seed.length; i += 1) {
      hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
    }

    const percentile = (hash % 10000) / 10000
    return percentile < sampleRate
  }

  public async verify(
    data: VerifyRequest
  ): Promise<Result<VerificationResult, FetchError | UnPriceCustomerError>> {
    const key = `verify:${env.APP_ENV}:${data.projectId}:${data.customerId}:${data.featureSlug}:`
    const cached = this.hashCache.get(key)

    const parsedCached = cached ? (JSON.parse(cached) as VerificationResult) : undefined

    // if we hit the same isolate we can return the cached result, only for request that are denied.
    if (parsedCached && parsedCached.allowed === false && env.APP_ENV === "production") {
      parsedCached.latency = 0
      return Ok({ ...parsedCached, cacheHit: true })
    }

    const durableObject = this.getStub(
      this.getDurableObjectCustomerId(data.customerId, data.projectId)
    )

    try {
      // this is the most expensive call in terms of latency
      // this will trigger a call to the DO and validate the entitlement given the current usage
      // wrap with timeout to prevent hanging requests
      const result = await this.withTimeout(
        durableObject.verify(data),
        UsageLimiterService.DO_TIMEOUT_MS,
        "DO.verify"
      )

      // in extreme cases we hit in memory cache for the same isolate, speeding up the next request
      this.updateCache(key, result)

      return Ok(result)
    } catch (error) {
      // DO unavailable or timed out - attempt graceful degradation
      const errorMessage = error instanceof Error ? error.message : String(error)

      this.logger.warn("DO unavailable for verify, attempting fallback", {
        customerId: data.customerId,
        projectId: data.projectId,
        featureSlug: data.featureSlug,
        error: errorMessage,
        operation: "verify",
        degraded: true,
      })

      // 1. Try local in-memory cache first (0ms, same isolate)
      if (parsedCached) {
        this.logger.info("Returning degraded response from local cache", {
          customerId: data.customerId,
          featureSlug: data.featureSlug,
        })
        return Ok({
          ...parsedCached,
          degraded: true,
          degradedReason: "DO_UNAVAILABLE_USING_LOCAL_CACHE",
          cacheHit: true,
        })
      }

      // 2. Try distributed cache for entitlement state (only on failure path)
      const entitlementCacheKey = `${data.projectId}:${data.customerId}:${data.featureSlug}`
      const { val: cachedEntitlement } =
        await this.cache.customerEntitlement.get(entitlementCacheKey)

      if (cachedEntitlement) {
        this.logger.info("Returning degraded response from distributed cache", {
          customerId: data.customerId,
          featureSlug: data.featureSlug,
        })
        return Ok(
          this.buildDegradedVerifyResponse(
            cachedEntitlement,
            data.usage,
            "DO_UNAVAILABLE_USING_DISTRIBUTED_CACHE"
          )
        )
      }

      if ((data.usage ?? 0) > 0 && this.shouldRunProbabilisticVerify(data)) {
        this.logger.warn("Running probabilistic degraded verify", {
          customerId: data.customerId,
          featureSlug: data.featureSlug,
          projectId: data.projectId,
        })

        const probabilistic = await this.entitlementService.verify(data)

        return Ok({
          ...probabilistic,
          degraded: true,
          degradedReason: "DO_UNAVAILABLE_PROBABILISTIC_VERIFY",
        })
      }

      // 3. No cached state available - fail open with warning
      // This is the safest option for service continuity
      this.logger.warn("No cached state available, failing open", {
        customerId: data.customerId,
        featureSlug: data.featureSlug,
      })

      return Ok({
        allowed: true,
        degraded: true,
        degradedReason: "DO_UNAVAILABLE_NO_CACHE",
        message: "Service temporarily degraded - access granted with limited data",
      })
    }
  }

  public async reportUsage(
    data: ReportUsageRequest
  ): Promise<Result<ReportUsageResult, FetchError | UnPriceCustomerError>> {
    // in dev we use the idempotence key and timestamp to deduplicate reuse the same key for the same request
    const idempotentKey =
      env.APP_ENV === "production"
        ? `${data.idempotenceKey}`
        : `${data.idempotenceKey}:${data.timestamp}`

    const cacheKey = `${data.projectId}:${data.customerId}:${data.featureSlug}:${idempotentKey}`
    // Fast path: check if the event has already been sent to the DO
    const { val: sent } = await this.cache.idempotentRequestUsageByHash.get(cacheKey)

    // if the usage is already sent, return the result
    if (sent) {
      return Ok({ ...sent, cacheHit: true })
    }

    const durableObject = this.getStub(
      this.getDurableObjectCustomerId(data.customerId, data.projectId)
    )

    try {
      // Wrap with timeout to prevent hanging requests
      const result = await this.withTimeout(
        durableObject.reportUsage({
          ...data,
          idempotenceKey: idempotentKey,
        }),
        UsageLimiterService.DO_TIMEOUT_MS,
        "DO.reportUsage"
      )

      this.waitUntil(
        // cache the result for the next time
        // update the cache with the new usage so we can check limit in the next request
        // without calling the DO again
        this.cache.idempotentRequestUsageByHash.set(cacheKey, result)
      )

      return Ok(result)
    } catch (error) {
      // DO unavailable or timed out - fail closed for usage reporting
      // This is critical for billing accuracy - we cannot lose usage data
      const errorMessage = error instanceof Error ? error.message : String(error)

      this.logger.error("DO unavailable for reportUsage, failing closed", {
        customerId: data.customerId,
        projectId: data.projectId,
        featureSlug: data.featureSlug,
        usage: data.usage,
        idempotenceKey: idempotentKey,
        error: errorMessage,
        operation: "reportUsage",
        degraded: true,
      })

      // Fail closed: return error so client can retry
      // This ensures no usage data is lost for billing
      return Err(
        new FetchError({
          message: `Usage reporting temporarily unavailable: ${errorMessage}. Please retry.`,
          retry: true,
          context: {
            url: "durable-object://usagelimiter/reportUsage",
            method: "RPC",
            customerId: data.customerId,
            projectId: data.projectId,
            featureSlug: data.featureSlug,
            reason: "DO_UNAVAILABLE",
          },
        })
      )
    }
  }

  public async resetEntitlements(params: {
    customerId: string
    projectId: string
  }): Promise<Result<void, BaseError>> {
    const durableObject = this.getStub(
      this.getDurableObjectCustomerId(params.customerId, params.projectId)
    )

    // reset the entitlements for the customer
    const result = await durableObject.resetEntitlements({
      customerId: params.customerId,
      projectId: params.projectId,
    })

    // Propagate error from DO reset
    if (result.err) {
      return Err(result.err)
    }

    return Ok(undefined)
  }

  public async resetUsage(params: {
    customerId: string
    projectId: string
  }): Promise<Result<void, BaseError>> {
    const durableObject = this.getStub(
      this.getDurableObjectCustomerId(params.customerId, params.projectId)
    )

    const result = await durableObject.resetUsage({
      customerId: params.customerId,
      projectId: params.projectId,
    })

    if (result.err) {
      return Err(result.err)
    }

    return Ok(undefined)
  }

  public async getActiveEntitlements(
    params: GetEntitlementsRequest
  ): Promise<Result<MinimalEntitlement[], BaseError>> {
    const durableObject = this.getStub(
      this.getDurableObjectCustomerId(params.customerId, params.projectId)
    )

    const { val: entitlements, err } = await durableObject.getActiveEntitlements(params)

    if (err) {
      return Err(err)
    }

    return Ok(entitlements)
  }

  public async getAccessControlList(data: {
    customerId: string
    projectId: string
    now: number
  }): Promise<{
    customerUsageLimitReached: boolean | null
    customerDisabled: boolean | null
    subscriptionStatus: SubscriptionStatus | null
  } | null> {
    return await this.entitlementService.getAccessControlList(data)
  }

  public async updateAccessControlList(data: {
    customerId: string
    projectId: string
    updates: Partial<NonNullable<CacheNamespaces["accessControlList"]>>
  }): Promise<void> {
    return await this.customerService.updateAccessControlList(data)
  }

  public async getCurrentUsage(
    data: GetUsageRequest
  ): Promise<Result<CurrentUsage, FetchError | BaseError>> {
    const durableObject = this.getStub(
      this.getDurableObjectCustomerId(data.customerId, data.projectId)
    )

    const result = await durableObject.getCurrentUsage(data)

    return result
  }

  public async getBufferMetrics(data: {
    customerId: string
    projectId: string
    windowSeconds?: 300 | 3600 | 86400 | 604800
  }): Promise<Result<BufferMetricsResponse, FetchError | BaseError>> {
    const durableObject = this.getStub(
      this.getDurableObjectCustomerId(data.customerId, data.projectId)
    )

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("DO.getBufferMetrics timed out")),
          UsageLimiterService.DO_TIMEOUT_MS
        )
      })

      const result = await Promise.race([
        durableObject.getBufferMetrics({ windowSeconds: data.windowSeconds }),
        timeoutPromise,
      ])

      if (result.err) {
        return Err(result.err)
      }

      return Ok(result.val)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      this.logger.error("DO unavailable for getBufferMetrics", {
        customerId: data.customerId,
        projectId: data.projectId,
        error: errorMessage,
        operation: "getBufferMetrics",
      })

      return Err(
        new FetchError({
          message: `Buffer metrics temporarily unavailable: ${errorMessage}`,
          retry: true,
          context: {
            url: "durable-object://usagelimiter/getBufferMetrics",
            method: "RPC",
            customerId: data.customerId,
            projectId: data.projectId,
            reason: "DO_UNAVAILABLE",
          },
        })
      )
    }
  }
}
