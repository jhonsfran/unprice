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
import { type BaseError, Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
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
import type { GetEntitlementsRequest, GetUsageRequest, UsageLimiter } from "./interface"

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
    })
  }

  // in memory cache with size and TTL limits
  // kid of hard to reach the limit as cloudflare can hit others isolates
  // but just in case we limit it to 1000 entries
  private updateCache(key: string, result: VerificationResult) {
    if (env.VERCEL_ENV === "production" && !result.allowed) {
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
    if (this.stats.isEUCountry && env.NODE_ENV === "production") {
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
    return `${env.NODE_ENV}:${projectId}:${customerId}`
  }

  public async verify(
    data: VerifyRequest
  ): Promise<Result<VerificationResult, FetchError | UnPriceCustomerError>> {
    const key = `verify:${env.NODE_ENV}:${data.projectId}:${data.customerId}:${data.featureSlug}:`
    const cached = this.hashCache.get(key)

    const parsedCached = cached ? (JSON.parse(cached) as VerificationResult) : undefined

    // if we hit the same isolate we can return the cached result, only for request that are denied.
    if (parsedCached && parsedCached.allowed === false && env.VERCEL_ENV === "production") {
      return Ok({ ...parsedCached, cacheHit: true })
    }

    const durableObject = this.getStub(
      this.getDurableObjectCustomerId(data.customerId, data.projectId)
    )

    // TODO: implement this if the request is async, we can validate entitlement from cache

    // this is the most expensive call in terms of latency
    // this will trigger a call to the DO and validate the entitlement given the current usage
    const result = await durableObject.verify(data)

    // in extreme cases we hit in memory cache for the same isolate, speeding up the next request
    this.updateCache(key, result)

    return Ok(result)
  }

  public async reportUsage(
    data: ReportUsageRequest
  ): Promise<Result<ReportUsageResult, FetchError | UnPriceCustomerError>> {
    // in dev we use the idempotence key and timestamp to deduplicate reuse the same key for the same request
    const idempotentKey =
      env.VERCEL_ENV === "production"
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
    const result = await durableObject.reportUsage({
      ...data,
      idempotenceKey: idempotentKey,
    })

    this.waitUntil(
      // cache the result for the next time
      // update the cache with the new usage so we can check limit in the next request
      // without calling the DO again
      this.cache.idempotentRequestUsageByHash.set(cacheKey, result)
    )

    return Ok(result)
  }

  public async resetEntitlements(params: {
    customerId: string
    projectId: string
  }): Promise<Result<void, BaseError>> {
    const durableObject = this.getStub(
      this.getDurableObjectCustomerId(params.customerId, params.projectId)
    )

    // reset the entitlements for the customer
    await durableObject.resetEntitlements({
      customerId: params.customerId,
      projectId: params.projectId,
    })

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
}
