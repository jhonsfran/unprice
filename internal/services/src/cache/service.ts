import { type Cache as C, type Context, Namespace, createCache } from "@unkey/cache"
import { withMetrics } from "@unkey/cache/middleware"

import { MemoryStore, type Store } from "@unkey/cache/stores"
import type { Metrics } from "../metrics"
import type { CacheNamespace, CacheNamespaces } from "./namespaces"
import {
  CACHE_ANALYTICS_FRESHNESS_TIME_MS,
  CACHE_ANALYTICS_STALENESS_TIME_MS,
  CACHE_FRESHNESS_TIME_MS,
  CACHE_STALENESS_TIME_MS,
} from "./stale-while-revalidate"

// because this is instantiated as global, the map persist in memory for different requests
const persistentMap = new Map()

export type Cache = C<CacheNamespaces>

export class CacheService {
  private cache: Cache | null = null
  private context: Context
  private metrics: Metrics
  private readonly emitMetrics: boolean
  private isInitialized: boolean

  constructor(context: Context, metrics: Metrics, emitMetrics: boolean) {
    this.context = context
    this.metrics = metrics
    this.emitMetrics = emitMetrics
    this.isInitialized = false
  }

  /**
   * Initialize the cache service
   * @param extraStores - Extra stores to add to the cache
   */
  init(extraStores: Store<CacheNamespace, CacheNamespaces[CacheNamespace]>[]): void {
    if (this.isInitialized || this.cache) return

    // emit the cache size
    this.context.waitUntil(
      Promise.all([
        this.metrics.emit({
          metric: "metric.cache.size",
          tier: "memory",
          size: persistentMap.size,
          name: "cache",
        }),
      ])
    )

    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const stores: Array<Store<CacheNamespace, any>> = []

    const memory = new MemoryStore<CacheNamespace, CacheNamespaces[CacheNamespace]>({
      persistentMap,
      unstableEvictOnSet: {
        frequency: 0.1,
        maxItems: 5000,
      },
    })

    // push the memory first to hit it first
    stores.push(memory)

    // push the extra stores in the same order as the extraStores
    stores.push(...extraStores)

    const metricsMiddleware = withMetrics(this.metrics)
    const storesWithMetrics = this.emitMetrics
      ? stores.map((s) => metricsMiddleware.wrap(s))
      : stores

    const defaultOpts = {
      stores: storesWithMetrics,
      fresh: CACHE_FRESHNESS_TIME_MS,
      stale: CACHE_STALENESS_TIME_MS,
    }

    this.cache = createCache({
      apiKeyByHash: new Namespace<CacheNamespaces["apiKeyByHash"]>(this.context, defaultOpts),
      customerEntitlement: new Namespace<CacheNamespaces["customerEntitlement"]>(this.context, {
        ...defaultOpts,
        fresh: 1000 * 60 * 60 * 24, // 24 hours
        stale: 1000 * 60 * 60 * 1, // 1 hour
      }),
      accessControlList: new Namespace<CacheNamespaces["accessControlList"]>(this.context, {
        ...defaultOpts,
        fresh: 1000 * 60 * 1, // Consider them "fresh" for 1 minute
        stale: 1000 * 60 * 60, // Use old data for 1 hour while fetching new data in background
      }),
      customerEntitlements: new Namespace<CacheNamespaces["customerEntitlements"]>(this.context, {
        ...defaultOpts,
        fresh: 1000 * 60 * 60 * 24, // 24 hours
        stale: 1000 * 60 * 60 * 1, // 1 hour
      }),
      negativeEntitlements: new Namespace<CacheNamespaces["negativeEntitlements"]>(this.context, {
        ...defaultOpts,
        fresh: 1000 * 60, // 1 minute
        stale: 1000 * 60, // 1 minute
      }),
      customerSubscription: new Namespace<CacheNamespaces["customerSubscription"]>(this.context, {
        ...defaultOpts,
        fresh: 1000 * 60 * 60 * 24, // 24 hours
        stale: 1000 * 60 * 60 * 1, // 1 hour
      }),
      customerPaymentMethods: new Namespace<CacheNamespaces["customerPaymentMethods"]>(
        this.context,
        defaultOpts
      ),
      customer: new Namespace<CacheNamespaces["customer"]>(this.context, defaultOpts),
      planVersionList: new Namespace<CacheNamespaces["planVersionList"]>(this.context, defaultOpts),
      planVersion: new Namespace<CacheNamespaces["planVersion"]>(this.context, defaultOpts),
      projectFeatures: new Namespace<CacheNamespaces["projectFeatures"]>(this.context, defaultOpts),
      idempotentRequestUsageByHash: new Namespace<CacheNamespaces["idempotentRequestUsageByHash"]>(
        this.context,
        {
          ...defaultOpts,
          fresh: 1000 * 30, // 30 seconds
          stale: 1000 * 60, // delete after 1 minute
        }
      ),
      pageCountryVisits: new Namespace<CacheNamespaces["pageCountryVisits"]>(this.context, {
        ...defaultOpts,
        fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS, // 30 seconds
        stale: CACHE_ANALYTICS_STALENESS_TIME_MS, // revalidate 1 hour
      }),
      pageBrowserVisits: new Namespace<CacheNamespaces["pageBrowserVisits"]>(this.context, {
        ...defaultOpts,
        fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS, // 30 seconds
        stale: CACHE_ANALYTICS_STALENESS_TIME_MS, // revalidate 1 hour
      }),
      getPagesOverview: new Namespace<CacheNamespaces["getPagesOverview"]>(this.context, {
        ...defaultOpts,
        fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS, // 30 seconds
        stale: CACHE_ANALYTICS_STALENESS_TIME_MS, // revalidate 1 hour
      }),
      getFeatureHeatmap: new Namespace<CacheNamespaces["getFeatureHeatmap"]>(this.context, {
        ...defaultOpts,
        fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS, // 30 seconds
        stale: CACHE_ANALYTICS_STALENESS_TIME_MS, // revalidate 1 hour
      }),
      getFeaturesOverview: new Namespace<CacheNamespaces["getFeaturesOverview"]>(this.context, {
        ...defaultOpts,
        fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS, // 30 seconds
        stale: CACHE_ANALYTICS_STALENESS_TIME_MS, // revalidate 1 hour
      }),
      getPlansStats: new Namespace<CacheNamespaces["getPlansStats"]>(this.context, {
        ...defaultOpts,
        fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS, // 30 seconds
        stale: CACHE_ANALYTICS_STALENESS_TIME_MS, // revalidate 1 hour
      }),
      getPlansConversion: new Namespace<CacheNamespaces["getPlansConversion"]>(this.context, {
        ...defaultOpts,
        fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS, // 30 seconds
        stale: CACHE_ANALYTICS_STALENESS_TIME_MS, // revalidate 1 hour
      }),
      getOverviewStats: new Namespace<CacheNamespaces["getOverviewStats"]>(this.context, {
        ...defaultOpts,
        fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS, // 30 seconds
        stale: CACHE_ANALYTICS_STALENESS_TIME_MS, // revalidate 1 hour
      }),
      getUsage: new Namespace<CacheNamespaces["getUsage"]>(this.context, {
        ...defaultOpts,
        fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS, // 30 seconds
        stale: CACHE_ANALYTICS_STALENESS_TIME_MS, // revalidate 1 hour
      }),
      getVerifications: new Namespace<CacheNamespaces["getVerifications"]>(this.context, {
        ...defaultOpts,
        fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS, // 30 seconds
        stale: CACHE_ANALYTICS_STALENESS_TIME_MS, // revalidate 1 hour
      }),
      getVerificationRegions: new Namespace<CacheNamespaces["getVerificationRegions"]>(
        this.context,
        {
          ...defaultOpts,
          fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS, // 30 seconds
          stale: CACHE_ANALYTICS_STALENESS_TIME_MS, // revalidate 1 hour
        }
      ),
      getCurrentUsage: new Namespace<CacheNamespaces["getCurrentUsage"]>(this.context, {
        ...defaultOpts,
        fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS, // 30 seconds
        stale: CACHE_ANALYTICS_STALENESS_TIME_MS, // revalidate 1 hour
      }),
    })

    this.isInitialized = true
  }

  /**
   * Get the cache
   */
  getCache(): Cache {
    if (!this.isInitialized || !this.cache) {
      throw new Error("Cache not initialized. Call init() first.")
    }

    return this.cache
  }
}
