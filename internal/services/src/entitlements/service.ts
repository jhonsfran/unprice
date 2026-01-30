import type { Analytics } from "@unprice/analytics"
import { type Database, and, eq } from "@unprice/db"
import {
  AGGREGATION_CONFIG,
  add,
  currencies,
  dinero,
  formatMoney,
  toDecimal,
} from "@unprice/db/utils"
import type { Dinero } from "@unprice/db/utils"
import {
  type Currency,
  type CurrentUsage,
  type Entitlement,
  type EntitlementState,
  type MeterState,
  type MinimalEntitlement,
  type ReportUsageRequest,
  type ReportUsageResult,
  type VerificationResult,
  type VerifyRequest,
  calculateCycleWindow,
  calculateWaterfallPrice,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import {
  type Logger,
  type WideEventHelpers,
  type WideEventLogger,
  createWideEventHelpers,
} from "@unprice/logging"
import { format, subMinutes } from "date-fns"
import { toZonedTime } from "date-fns-tz"
import { BillingService } from "../billing"
import type { CacheNamespaces } from "../cache/namespaces"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { retry } from "../utils/retry"
import { UnPriceEntitlementError, type UnPriceEntitlementStorageError } from "./errors"
import { GrantsManager } from "./grants"
import type { UnPriceEntitlementStorage } from "./storage-provider"

import { customers, entitlements, subscriptions } from "@unprice/db/schema"
import { ulid } from "ulid"
import { CustomerService } from "../customers/service"
import { UsageMeter } from "./usage-meter"

/**
 * Simplified Entitlement Service
 *
 * Strategy:
 * - Keep usage in cache (DO/Redis) for low latency
 * - Smart revalidation: lightweight version check, only reload if changed
 * - All logic encapsulated in service (minimize round-trips)
 * - Buffering support for batch analytics
 */
export class EntitlementService {
  private readonly grantsManager: GrantsManager
  private readonly revalidateInterval: number
  private readonly db: Database
  private readonly storage: UnPriceEntitlementStorage
  private readonly logger: Logger
  private readonly analytics: Analytics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private readonly cache: Cache
  private readonly metrics: Metrics
  private readonly customerService: CustomerService
  private readonly wideEventHelpers: WideEventHelpers

  constructor(opts: {
    db: Database
    storage: UnPriceEntitlementStorage
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
    wideEventLogger?: WideEventLogger | null
    config?: {
      revalidateInterval?: number // How often to check for version changes
    }
  }) {
    this.revalidateInterval = opts.config?.revalidateInterval ?? 300000 // 5 minutes default

    this.grantsManager = new GrantsManager({
      db: opts.db,
      logger: opts.logger,
    })
    this.db = opts.db
    this.storage = opts.storage
    this.logger = opts.logger
    this.analytics = opts.analytics
    this.waitUntil = opts.waitUntil
    this.cache = opts.cache
    this.metrics = opts.metrics
    this.wideEventHelpers = createWideEventHelpers(opts.wideEventLogger)
    this.customerService = new CustomerService({
      db: opts.db,
      logger: opts.logger,
      analytics: opts.analytics,
      waitUntil: opts.waitUntil,
      cache: opts.cache,
      metrics: opts.metrics,
    })
  }

  /**
   * Helper to add structured entitlement context to wide events.
   * Groups everything under "entitlements" key for clear identification in logs.
   * Keeps only essential information for debugging.
   */
  private addEntitlementContext(
    context: Parameters<WideEventHelpers["addEntitlement"]>[0],
    helpers?: WideEventHelpers
  ) {
    ;(helpers ?? this.wideEventHelpers).addEntitlement(context)
  }

  /**
   * Safely rounds a number to 2 decimal places
   * Handles edge cases like NaN, Infinity, null, and undefined
   */
  private roundToTwoDecimals(value: number | null | undefined): number | undefined {
    if (value === null || value === undefined) {
      return undefined
    }
    if (!Number.isFinite(value)) {
      return undefined
    }
    return Math.round(value * 100) / 100
  }

  private getUsageMeter(validatedState: EntitlementState): UsageMeter {
    return new UsageMeter(
      {
        capacity: validatedState.limit ?? Number.POSITIVE_INFINITY,
        aggregationMethod: validatedState.aggregationMethod,
        featureType: validatedState.featureType,
        resetConfig: validatedState.resetConfig,
        startDate: validatedState.effectiveAt,
        threshold: (validatedState.metadata?.notifyUsageThreshold ?? 95) / 100, // when close to the limit, send a notification
        endDate: validatedState.expiresAt,
        overageStrategy: validatedState.metadata?.overageStrategy,
      },
      validatedState.meter // Restore UsageMeter from persisted state
    )
  }

  /**
   * Check if usage is allowed (low latency)
   * Handles cache miss and revalidation internally (single network call)
   */
  async verify(params: VerifyRequest, logger?: WideEventLogger): Promise<VerificationResult> {
    const helpers = logger ? createWideEventHelpers(logger) : undefined

    // Add business context once at the start
    const { err: stateErr, val: state } = await this.getStateWithRevalidation({
      customerId: params.customerId,
      projectId: params.projectId,
      featureSlug: params.featureSlug,
      now: params.timestamp,
    })

    if (stateErr) {
      this.addEntitlementContext(
        {
          allowed: false,
          denied_reason: "ENTITLEMENT_ERROR",
        },
        helpers
      )
      return {
        allowed: false,
        message: stateErr.message,
        deniedReason: "ENTITLEMENT_ERROR",
      }
    }

    if (!state) {
      this.addEntitlementContext(
        {
          allowed: false,
          denied_reason: "ENTITLEMENT_NOT_FOUND",
          state_found: false,
        },
        helpers
      )
      const latency = performance.now() - params.performanceStart
      this.waitUntil(
        this.storage.insertVerification({
          customerId: params.customerId,
          projectId: params.projectId,
          featureSlug: params.featureSlug,
          timestamp: params.timestamp,
          allowed: 0,
          deniedReason: "ENTITLEMENT_NOT_FOUND",
          metadata: {
            ...params.metadata,
            usage: (params.usage ?? 0).toString(),
            remaining: "0",
          },
          latency,
          requestId: params.requestId,
          createdAt: Date.now(),
        })
      )

      return {
        allowed: false,
        message: "No entitlement found for the given customer, project and feature",
        deniedReason: "ENTITLEMENT_NOT_FOUND",
        usage: 0,
        limit: undefined,
      }
    }

    const { err, val: validatedState } = this.validateEntitlementState({
      state: state,
      now: params.timestamp,
    })

    if (err) {
      const latency = performance.now() - params.performanceStart
      return {
        allowed: false,
        message: err.message,
        deniedReason: "ENTITLEMENT_ERROR",
        latency,
        featureType: state.featureType,
      }
    }

    const usageMeter = this.getUsageMeter(validatedState)
    const verifyResult = usageMeter.verify(params.timestamp, params.usage)
    const latency = performance.now() - params.performanceStart

    this.waitUntil(
      this.storage.insertVerification({
        customerId: params.customerId,
        projectId: params.projectId,
        featureSlug: params.featureSlug,
        timestamp: params.timestamp,
        allowed: verifyResult.allowed ? 1 : 0,
        deniedReason: verifyResult.deniedReason ?? undefined,
        metadata: {
          ...params.metadata,
          usage: (params.usage ?? 0).toString(),
          remaining: verifyResult.remaining.toString(),
        },
        latency,
        requestId: params.requestId,
        createdAt: Date.now(),
      })
    )

    const meterResult = usageMeter.toPersist()

    const shouldBlockCustomer =
      verifyResult.deniedReason === "LIMIT_EXCEEDED" &&
      validatedState.metadata?.blockCustomer === true

    await this.storage.set({ state: { ...validatedState, meter: meterResult } })

    this.addEntitlementContext(
      {
        allowed: verifyResult.allowed,
        denied_reason: verifyResult.deniedReason,
        feature_type: validatedState.featureType,
        limit: validatedState.limit ?? undefined,
        usage: Number(meterResult.usage),
        remaining: verifyResult.remaining,
      },
      helpers
    )

    this.waitUntil(
      this.customerService.updateAccessControlList({
        customerId: params.customerId,
        projectId: params.projectId,
        updates: { customerUsageLimitReached: shouldBlockCustomer },
      })
    )

    return this.buildVerificationResponse({
      verifyResult,
      validatedState,
      latency,
      meterResult,
    })
  }

  private buildVerificationResponse(params: {
    verifyResult: ReturnType<UsageMeter["verify"]>
    validatedState: EntitlementState
    latency: number
    meterResult: MeterState
  }): VerificationResult {
    const { verifyResult, validatedState, latency, meterResult } = params

    return {
      allowed: verifyResult.allowed,
      message: verifyResult.allowed ? "Allowed" : (verifyResult.message ?? "Limit exceeded"),
      deniedReason: verifyResult.allowed
        ? undefined
        : (verifyResult.deniedReason ?? "LIMIT_EXCEEDED"),
      usage: Number(meterResult.usage),
      limit: validatedState.limit ?? undefined,
      remaining: verifyResult.remaining,
      latency,
      featureType: validatedState.featureType,
    }
  }

  private calculateCostAndRate(params: {
    state: EntitlementState
    usage: number
  }): { cost?: number; rate?: string; rateAmount?: number; rateCurrency?: string } {
    const { state, usage } = params

    // Only calculate for usage-based features
    if (state.featureType === "flat") {
      return {}
    }

    const { val: result, err } = calculateWaterfallPrice({
      grants: state.grants
        .filter((g) => !!g.config)
        .map((g) => ({
          id: g.id,
          limit: g.limit,
          priority: g.priority,
          config: g.config!,
          prorate: 1,
        })),
      usage,
      featureType: state.featureType,
    })

    if (err) {
      // Log pricing calculation errors (private helper - caller handles response)
      this.logger.warn("calculateCostAndRate failed", {
        error: err.message,
        errorType: err.name,
      })
      return {}
    }

    const totalCost = this.roundToTwoDecimals(
      Number(toDecimal(result.totalPrice.totalPrice.dinero))
    )

    // Rate is the unit price of the last item (marginal rate)
    const lastItem = result.items[result.items.length - 1]
    const primaryRate = lastItem ? lastItem.price.unitPrice.displayAmount : ""
    const rateAmount = lastItem
      ? this.roundToTwoDecimals(Number(toDecimal(lastItem.price.unitPrice.dinero)))
      : undefined
    const rateCurrency = lastItem
      ? lastItem.price.unitPrice.dinero.toJSON().currency.code
      : undefined

    return {
      cost: totalCost,
      rate: primaryRate,
      rateAmount,
      rateCurrency,
    }
  }

  /**
   * Report usage with priority-based consumption
   * Handles revalidation internally (single network call)
   */
  async reportUsage(
    params: ReportUsageRequest,
    logger?: WideEventLogger
  ): Promise<ReportUsageResult> {
    const helpers = logger ? createWideEventHelpers(logger) : undefined

    const { err: stateErr, val: state } = await this.getStateWithRevalidation({
      customerId: params.customerId,
      projectId: params.projectId,
      featureSlug: params.featureSlug,
      now: params.timestamp,
    })

    if (stateErr) {
      this.addEntitlementContext(
        {
          allowed: false,
          denied_reason: "ENTITLEMENT_ERROR",
        },
        helpers
      )
      return {
        allowed: false,
        message: stateErr.message,
        deniedReason: "ENTITLEMENT_ERROR",
        usage: 0,
      }
    }

    if (!state) {
      this.addEntitlementContext(
        {
          allowed: false,
          denied_reason: "ENTITLEMENT_NOT_FOUND",
          state_found: false,
        },
        helpers
      )
      return {
        allowed: false,
        message: "No entitlement found for the given customer, project and feature",
        deniedReason: "ENTITLEMENT_NOT_FOUND",
        usage: 0,
      }
    }

    const { err, val: validatedState } = this.validateEntitlementState({
      state: state,
      now: params.timestamp,
    })

    if (err) {
      return {
        allowed: false,
        message: err.message,
        deniedReason: "ENTITLEMENT_ERROR",
        usage: 0,
      }
    }

    const usageMeter = this.getUsageMeter(validatedState)

    const { val: keyExists } = await this.storage.hasIdempotenceKey(params.idempotenceKey)

    if (keyExists) {
      const meterResult = usageMeter.toPersist()

      const { cost } = this.calculateCostAndRate({
        state: validatedState,
        usage: Number(meterResult.usage),
      })

      this.addEntitlementContext(
        {
          allowed: true,
          key_exists: true,
          already_recorded: true,
          cost,
          usage: Number(meterResult.usage),
          limit: validatedState.limit ?? undefined,
        },
        helpers
      )

      return {
        allowed: true,
        message: "Usage already recorded (idempotent)",
        deniedReason: undefined,
        usage: Number(meterResult.usage),
        limit: validatedState.limit ?? undefined,
        notifiedOverLimit: false,
        cost,
      }
    }

    const consumeResult = usageMeter.consume(params.usage, params.timestamp)
    const meterResult = usageMeter.toPersist()

    await this.storage.set({
      state: {
        ...validatedState,
        meter: meterResult,
      },
    })

    if (consumeResult.allowed) {
      // Calculate incremental cost
      const totalUsageAfter = Number(meterResult.usage)
      const totalUsageBefore = totalUsageAfter - params.usage

      const {
        cost: costAfter,
        rate,
        rateAmount,
        rateCurrency,
      } = this.calculateCostAndRate({
        state: validatedState,
        usage: totalUsageAfter,
      })

      const { cost: costBefore } = this.calculateCostAndRate({
        state: validatedState,
        usage: totalUsageBefore,
      })

      const incrementalCost = this.roundToTwoDecimals((costAfter ?? 0) - (costBefore ?? 0)) ?? 0

      const usageRecord = {
        id: ulid(),
        customerId: params.customerId,
        projectId: params.projectId,
        featureSlug: params.featureSlug,
        usage: params.usage,
        timestamp: params.timestamp,
        idempotenceKey: params.idempotenceKey,
        requestId: params.requestId,
        createdAt: Date.now(),
        metadata: {
          ...params.metadata,
          cost: incrementalCost.toString(),
          rate: rate ?? "",
          rateAmount: (this.roundToTwoDecimals(rateAmount) ?? 0).toString(),
          rateCurrency: rateCurrency ?? "",
        },
        deleted: 0,
      }

      this.waitUntil(this.storage.insertUsageRecord(usageRecord))
    }

    const shouldBlockCustomer =
      consumeResult.deniedReason === "LIMIT_EXCEEDED" &&
      validatedState.metadata?.blockCustomer === true

    this.addEntitlementContext(
      {
        allowed: consumeResult.allowed,
        denied_reason: consumeResult.deniedReason,
        feature_type: validatedState.featureType,
        limit: validatedState.limit ?? undefined,
        usage: Number(meterResult.usage),
        remaining: consumeResult.remaining,
        cost: this.calculateCostAndRate({
          state: validatedState,
          usage: Number(meterResult.usage),
        }).cost,
      },
      helpers
    )

    if (
      shouldBlockCustomer ||
      (params.usage < 0 && consumeResult.allowed && consumeResult.remaining > 0)
    ) {
      this.waitUntil(
        this.customerService.updateAccessControlList({
          customerId: params.customerId,
          projectId: params.projectId,
          updates: {
            customerUsageLimitReached: shouldBlockCustomer,
            // check if we need to block the customer because of negative usage (refund)
          },
        })
      )
    }

    return this.buildReportUsageResponse({
      consumeResult,
      validatedState,
      meterResult,
    })
  }

  private buildReportUsageResponse(params: {
    consumeResult: ReturnType<UsageMeter["consume"]>
    validatedState: EntitlementState
    meterResult: MeterState
  }): ReportUsageResult {
    const { consumeResult, validatedState, meterResult } = params

    // Calculate cost and rate
    const { cost } = this.calculateCostAndRate({
      state: validatedState,
      usage: Number(meterResult.usage),
    })

    return {
      allowed: consumeResult.allowed,
      remaining: consumeResult.remaining,
      message: consumeResult.message,
      deniedReason: consumeResult.deniedReason,
      usage: Number(meterResult.usage),
      limit: validatedState.limit ?? undefined,
      cost,
      notifiedOverLimit: consumeResult.overThreshold,
    }
  }

  public async flush(): Promise<
    Result<void, UnPriceEntitlementError | UnPriceEntitlementStorageError>
  > {
    // flush the usage records
    await this.storage.flush()
    return Ok(undefined)
  }

  /* we cannot trust in the storage since it could be not initilize yet.
   */
  /**
   * Get active entitlements for a customer
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param now - Current time
   * @param opts - Options
   * @returns Active entitlements
   */
  public async getActiveEntitlements({
    customerId,
    projectId,
    opts,
  }: {
    customerId: string
    projectId: string
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
      now?: number
    }
  }): Promise<Result<MinimalEntitlement[], FetchError | UnPriceEntitlementError>> {
    // Add business context once at the start
    this.wideEventHelpers.addBusiness({
      operation: "getActiveEntitlements",
      customer_id: customerId,
      project_id: projectId,
    })

    const cacheKey = `${projectId}:${customerId}`

    // first try to get the entitlement from cache, if not found try to get it from DO,
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getActiveEntitlementsFromDB({
            customerId,
            projectId,
          }),
          (err) =>
            new FetchError({
              message: `unable to query entitlements from db in getActiveEntitlementsFromDB - ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                customerId: customerId,
                projectId: projectId,
                method: "getActiveEntitlementsFromDB",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.customerEntitlements.swr(cacheKey, () =>
              this.getActiveEntitlementsFromDB({
                customerId,
                projectId,
              })
            ),
          () => {}
        )

    if (err) {
      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    let entitlements = val

    // 2. LAZY COMPUTATION: If missing or forcing revalidation, compute from grants
    if (entitlements?.length === 0) {
      const negativeCacheKey = `negative:${projectId}:${customerId}:all`
      const { val: isNegative } = opts?.skipCache
        ? { val: false }
        : await this.cache.negativeEntitlements.get(negativeCacheKey)

      if (isNegative) {
        return Ok([])
      }

      const computeResult = await this.grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now: opts?.now ?? Date.now(),
      })

      if (computeResult.err) {
        return Err(new UnPriceEntitlementError({ message: computeResult.err.message }))
      }

      entitlements = computeResult.val ?? []

      // Update cache with the freshly computed entitlement
      this.waitUntil(this.cache.customerEntitlements.set(cacheKey, entitlements))

      if (entitlements.length === 0) {
        this.waitUntil(this.cache.negativeEntitlements.set(negativeCacheKey, true))
      }
    }

    if (!entitlements || entitlements.length === 0) {
      return Ok([])
    }

    return Ok(entitlements)
  }

  /**
   * RECONCILE: We need to reconcile the usage in storage with the source of truth in analytics.
   * This is extremly important to avoid double counting usage and other race conditions.
   * To do that we use a cursor to mark the position in the analytics and we compare the usage in storage with the usage in analytics.
   * in case of drift we add to the global counter to avoid rewrites, the global counter is a moving target as we add usage as per request.
   *
   * Timeline:
   *
   * | ◄──────────────── DO's globalCounter includes ALL of this ─────────────────────►  │
   * |                                                                                   │
   * ├─ effectiveAt (open ended) ────────────────────────────────────────────────────── now
   * |                                                                                   │
   * ├───────────| start new cycle window ──────────── end cycle window ─|───────────── now
   * |                                                                                   │
   * [ ... Verified in TB ... ]   [ ... In Flight / Settling ... ]   [ ... In Buffer ... ]
   * |                                                                                   │
   * |────────Analytics ──────|── Analytics not ready yet  ──────────|────── Storage ────|
   *             ▲            ▲
   *             │            │
   *    lastReconciledId   beforeRecordId (watermark)
   *             | -tb query- │
   */
  private async reconcileFeatureUsage(params: { state: EntitlementState; now: number }) {
    const { state, now } = params
    // 5 minutes ago is more than enough for tb to settle the usage
    const watermark = subMinutes(new Date(now), 5).getTime()

    // Immutable snapshot for avoiding race conditions
    const snapshot: Readonly<EntitlementState> = { ...state }

    // Add business context once at the start (this runs in background, needs its own context)
    this.wideEventHelpers.addBusiness({
      operation: "reconcileFeatureUsage",
      customer_id: snapshot.customerId,
      project_id: snapshot.projectId,
      feature_slug: snapshot.featureSlug,
    })

    const config = AGGREGATION_CONFIG[snapshot.aggregationMethod]
    const meter = snapshot.meter

    // if the feature is a flat feature we don't need to reconcile
    if (snapshot.featureType === "flat") {
      this.logger.debug("skipping reconcile for flat feature", {
        featureSlug: snapshot.featureSlug,
        customerId: snapshot.customerId,
        projectId: snapshot.projectId,
      })
      return // fire-and-forget
    }

    // drift only makes sense for sum behavior
    if (config.behavior !== "sum") {
      this.logger.debug("skipping reconcile for non-sum behavior", {
        behavior: config.behavior,
        featureSlug: snapshot.featureSlug,
        customerId: snapshot.customerId,
        projectId: snapshot.projectId,
        aggregationMethod: snapshot.aggregationMethod,
        featureType: snapshot.featureType,
      })
      return // fire-and-forget
    }

    // calculate the cycle window for the watermark
    // for non reset config we use the effective at
    const watermarkCycleWindow = snapshot.resetConfig
      ? calculateCycleWindow({
          effectiveStartDate: snapshot.effectiveAt,
          effectiveEndDate: snapshot.expiresAt,
          now: watermark,
          config: {
            name: snapshot.resetConfig.name,
            interval: snapshot.resetConfig.resetInterval,
            intervalCount: snapshot.resetConfig.resetIntervalCount,
            anchor: snapshot.resetConfig.resetAnchor,
            planType: snapshot.resetConfig.planType,
          },
          trialEndsAt: null,
        })
      : null

    // avoid reconciliation if the watermark cycle has changed against the current cycle window
    // this avoid race condition between reset usage in cycles
    const currentCycleWindow = snapshot.resetConfig
      ? calculateCycleWindow({
          effectiveStartDate: snapshot.effectiveAt,
          effectiveEndDate: snapshot.expiresAt,
          now: Date.now(),
          config: {
            name: snapshot.resetConfig.name,
            interval: snapshot.resetConfig.resetInterval,
            intervalCount: snapshot.resetConfig.resetIntervalCount,
            anchor: snapshot.resetConfig.resetAnchor,
            planType: snapshot.resetConfig.planType,
          },
          trialEndsAt: null,
        })
      : null

    // avoid reconcile if there was a change in the cycle window
    if (
      watermarkCycleWindow &&
      currentCycleWindow &&
      watermarkCycleWindow.start !== currentCycleWindow.start
    ) {
      this.logger.debug("skipping reconcile, the watermark cycle window has changed", {
        watermarkCycleWindow: watermarkCycleWindow.start,
        currentCycleWindow: currentCycleWindow.start,
        featureSlug: snapshot.featureSlug,
        customerId: snapshot.customerId,
        projectId: snapshot.projectId,
        aggregationMethod: snapshot.aggregationMethod,
        featureType: snapshot.featureType,
      })
      return // fire-and-forget
    }

    // use the watermark cycle window start if it's available, otherwise use the effective at
    const effectiveAt = watermarkCycleWindow?.start ?? snapshot.effectiveAt
    const lastReconciledId = meter.lastReconciledId
    const beforeRecordId = ulid(watermark) // ulid is more reliable than timestamp

    // Only reconcile if we have at least 5 minutes of settled time
    // in the current cycle window
    if (lastReconciledId >= beforeRecordId) {
      this.logger.debug(
        "skipping reconcile, reconciliation already happened in the past 5 minutes",
        {
          lastReconciledId,
          beforeRecordId,
          featureSlug: snapshot.featureSlug,
          customerId: snapshot.customerId,
          projectId: snapshot.projectId,
        }
      )
      return // fire-and-forget
    }

    // if the cycle hasn't been started at least in the past 5 minutes we can't reconcile
    if (watermark < effectiveAt) {
      this.logger.debug(
        "skipping reconcile, not enough time has passed since the last reconciliation",
        {
          watermark,
          effectiveAt,
          featureSlug: snapshot.featureSlug,
          customerId: snapshot.customerId,
          projectId: snapshot.projectId,
        }
      )
      return // fire-and-forget
    }

    // if the last reconciled id is empty we can't reconcile.
    // this means something went wrong in the initialization of the meter or the entiltment was used for the first time.
    if (lastReconciledId === "") {
      this.logger.warn("skipping reconcile, the last reconciled id is empty", {
        lastReconciledId,
        featureSlug: snapshot.featureSlug,
        customerId: snapshot.customerId,
        projectId: snapshot.projectId,
      })
      return // fire-and-forget
    }

    // get the usage from analytics and current usage in storage at the same time
    // this give us the exact usage at the watermark and save it in the entitlement state for the next reconciliation
    const [analyticsResult, entitlementResult] = await Promise.all([
      this.analytics.getFeaturesUsageCursor({
        customerId: snapshot.customerId,
        projectId: snapshot.projectId,
        feature: {
          featureSlug: snapshot.featureSlug,
          aggregationMethod: snapshot.aggregationMethod,
          featureType: snapshot.featureType,
        },
        afterRecordId: lastReconciledId,
        beforeRecordId: beforeRecordId,
        startAt: effectiveAt,
      }),
      this.storage.get({
        customerId: snapshot.customerId,
        projectId: snapshot.projectId,
        featureSlug: snapshot.featureSlug,
      }),
    ])

    if (entitlementResult.err) {
      this.logger.error("Failed to get entitlement state", {
        error: entitlementResult.err.message,
      })
      return // fire-and-forget
    }

    if (analyticsResult.err) {
      this.logger.error("Analytics failed", {
        error: analyticsResult.err?.message ?? String(analyticsResult.err),
      })
      return // fire-and-forget
    }

    const entitlementState = entitlementResult.val

    if (!entitlementState) {
      this.logger.error("Failed to get entitlement state", {
        error: "Entitlement state not found",
      })
      return // fire-and-forget
    }

    // DO cursor usage and anchor
    const snapshotCurrentUsage = Number(meter.usage ?? 0) // DO's global counter at this point in time
    const snapshotLastReconciledUsage = Number(meter.snapshotUsage ?? 0) // DO's global counter at last reconciliation

    // analytics usage and last record id
    const analyticsUsage = Number(analyticsResult.val.usage ?? 0) // Total from analytics
    // Use || instead of ?? to also handle empty strings from analytics when there's no usage data yet
    const analyticsLastRecordId = analyticsResult.val.lastRecordId || beforeRecordId

    // EPSILON is the tolerance for the drift
    const EPSILON = 0.001
    // MAX_DRIFT is the maximum drift allowed
    const MAX_DRIFT = 1000

    // Utility to keep counters consistently stringified
    const toStore = (value: number | string) => value.toString()

    // drift only makes sense for sum behavior
    if (config.behavior === "sum") {
      // Compare analytics usage with DO's global counter at last reconciliation
      const drift = analyticsUsage - snapshotLastReconciledUsage

      if (Math.abs(drift) > MAX_DRIFT) {
        this.logger.error("Drift too large for sum", {
          drift,
          snapshotLastReconciledUsage,
          analyticsUsage,
          featureSlug: snapshot.featureSlug,
          customerId: snapshot.customerId,
          projectId: snapshot.projectId,
          aggregationMethod: snapshot.aggregationMethod,
          featureType: snapshot.featureType,
        })
        return
      }

      // only apply drift if it's greater than the tolerance
      if (Math.abs(drift) > EPSILON) {
        meter.usage = toStore(snapshotCurrentUsage + drift)
      }

      // update the snapshot usage and last reconciled id for the next reconciliation
      meter.usage = toStore(snapshotCurrentUsage)
      meter.lastReconciledId = analyticsLastRecordId
    }

    // Persist with updated reconciliation watermark, cursor position, and snapshot
    await this.storage.set({
      state: {
        ...entitlementState,
        meter: meter,
      },
    })
  }

  private async initializeUsageMeter(params: {
    entitlement: Entitlement
    watermark: number
    forceRefresh?: boolean
  }): Promise<Result<MeterState, FetchError | UnPriceEntitlementError>> {
    const { entitlement, watermark, forceRefresh } = params

    // this should happen as the initial state is stored in the storage
    // so if there is a storage definition we use that on initialization
    const { err: entitlementStateErr, val: entitlementState } = await this.storage.get({
      customerId: entitlement.customerId,
      projectId: entitlement.projectId,
      featureSlug: entitlement.featureSlug,
    })

    if (entitlementStateErr) {
      return Err(new UnPriceEntitlementError({ message: entitlementStateErr.message }))
    }

    // if the entitlement is already initialized and we don't want to force refresh, return it
    if (!forceRefresh && entitlementState?.meter) {
      return Ok(entitlementState.meter)
    }

    // if the entitlement is not initialized, initialize it from analytics
    const watermarkCycleWindow = entitlement.resetConfig
      ? calculateCycleWindow({
          effectiveStartDate: entitlement.effectiveAt,
          effectiveEndDate: entitlement.expiresAt,
          now: watermark,
          config: {
            name: entitlement.resetConfig.name,
            interval: entitlement.resetConfig.resetInterval,
            intervalCount: entitlement.resetConfig.resetIntervalCount,
            anchor: entitlement.resetConfig.resetAnchor,
            planType: entitlement.resetConfig.planType,
          },
          trialEndsAt: null,
        })
      : null

    // ulid is more reliable than timestamp because at high throughputs it can be not unique
    const beforeRecordId = ulid(watermark)
    // after record Id on initilization should be the begining of the cycle
    const afterRecordId = watermarkCycleWindow
      ? ulid(watermarkCycleWindow.start)
      : ulid(entitlement.effectiveAt)

    // analytics query will take care of calculating the usage and the cycle will be
    // aligned to the current cycle window
    const { err: analyticsErr, val: analyticsResult } = await this.analytics.getFeaturesUsageCursor(
      {
        customerId: entitlement.customerId,
        projectId: entitlement.projectId,
        feature: {
          featureSlug: entitlement.featureSlug,
          aggregationMethod: entitlement.aggregationMethod,
          featureType: entitlement.featureType,
        },
        afterRecordId: afterRecordId, // from the start of the cycle
        beforeRecordId: beforeRecordId, // Up to watermark (settled records)
        // if the entitlement has reset config we use the start of the current cycle window
        // otherwise we use the effective at
        startAt: watermarkCycleWindow?.start ?? entitlement.effectiveAt,
      }
    )

    if (analyticsErr) {
      // No analytics data yet or error, return error
      return Err(
        new UnPriceEntitlementError({
          message: "Failed to get analytics data for entitlement",
          context: {
            error: analyticsErr.message,
          },
        })
      )
    }

    const usage = analyticsResult.usage ?? 0 // Total from effectiveAt to watermark
    // Use || instead of ?? to also handle empty strings from analytics when there's no usage data yet
    const lastRecordId = analyticsResult.lastRecordId || beforeRecordId

    // initialize entitlement state
    return Ok({
      usage: usage.toString(),
      snapshotUsage: usage.toString(),
      lastReconciledId: lastRecordId,
      lastUpdated: Date.now(),
      lastCycleStart: watermarkCycleWindow?.start ?? entitlement.effectiveAt,
    })
  }

  /**
   * Get state with smart revalidation
   *
   * Strategy:
   * 1. Try cache first
   * 2. If cache miss, load from DB
   * 3. If cached but nextRevalidateAt passed:
   *    a. Do lightweight version check (just query version)
   *    b. If version differs, reload full entitlement
   *    c. Otherwise, just update nextRevalidateAt
   *
   * This minimizes DB queries while staying in sync
   */
  private async getStateWithRevalidation(params: {
    customerId: string
    projectId: string
    featureSlug: string
    now: number
    skipCache?: boolean
  }): Promise<
    Result<EntitlementState | null, UnPriceEntitlementError | UnPriceEntitlementStorageError>
  > {
    // get the entitlement from the storage
    // this is tier storage to get the entitlement from memory and if missed from kv storage
    const { err: storageErr, val: cached } = await this.storage.get(params)

    if (storageErr) {
      return Err(new UnPriceEntitlementError({ message: storageErr.message }))
    }

    // cache miss - load from cache
    if (!cached) {
      this.addEntitlementContext({
        state_found: false,
        cache_hit: false,
      })

      // get the entitlement from cache
      const { val, err } = await this.getActiveEntitlement({
        ...params,
        opts: {
          skipCache: false, // load from cache first
          now: params.now,
        },
      })

      if (err) {
        return Err(
          new UnPriceEntitlementError({
            message: `unable to get entitlement from cache - ${err.message}`,
          })
        )
      }

      if (!val) {
        // TODO: check renew date to see if the subscription is already renewed
        return Ok(null)
      }

      // set storage
      await this.storage.set({ state: val })

      return Ok(val)
    }

    // if already experied we need to reload the entitlement - expensive operation
    // this don't happen often, entitlement are open ended most of the time
    if (cached.expiresAt && params.now >= cached.expiresAt) {
      this.addEntitlementContext({
        revalidation_required: true,
      })

      try {
        // at expiration we need to recompute the grants because the end date has been reached
        const result = await this.grantsManager.computeGrantsForCustomer({
          customerId: params.customerId,
          projectId: params.projectId,
          now: params.now,
          featureSlug: params.featureSlug,
        })

        if (result.err) {
          throw new UnPriceEntitlementError({ message: result.err.message })
        }

        // get entitlements from the result
        const entitlement = result.val.find((e) => e.featureSlug === params.featureSlug)

        if (!entitlement) {
          // remove the entitlement from storage
          await this.storage.delete({
            customerId: params.customerId,
            projectId: params.projectId,
            featureSlug: params.featureSlug,
          })

          return Ok(null)
        }

        // trust the analytics data and sync the entitlement usage
        const meterState = await this.initializeUsageMeter({
          entitlement: entitlement,
          watermark: params.now,
          forceRefresh: true, // upon entitlement expiration we force refresh the usage meter
        })

        if (meterState.err) {
          throw new UnPriceEntitlementError({ message: meterState.err.message })
        }

        const entitlementState: EntitlementState = {
          ...entitlement,
          meter: meterState.val,
        }

        // set storage
        await this.storage.set({ state: entitlementState })

        return Ok(entitlementState)
      } catch (error) {
        const err = error as UnPriceEntitlementError
        this.logger.error(err.message, {
          ...params,
        })

        return Err(new UnPriceEntitlementError({ message: err.message }))
      }
    }

    // Cache hit - no cycle boundary crossed, check if we need to revalidate
    if (params.now >= cached.nextRevalidateAt || !cached.meter) {
      this.addEntitlementContext({
        revalidation_required: true,
        cache_hit: true,
      })

      let entitlementState: EntitlementState | undefined = undefined

      try {
        // get the entitlement from the cache
        const { val: entitlement, err } = await this.getActiveEntitlement({
          ...params,
          opts: {
            skipCache: params.skipCache,
            now: params.now,
          },
        })

        if (err) {
          return Err(
            new UnPriceEntitlementError({
              message: `unable to get entitlement from cache - ${err.message}`,
            })
          )
        }

        // no entitlement found, entitlement deleted from storage
        if (!entitlement) {
          // remove the entitlement from storage
          await this.storage.delete({
            customerId: params.customerId,
            projectId: params.projectId,
            featureSlug: params.featureSlug,
          })

          return Ok(null)
        }

        // if found let's check if the version mismatch or snapshot updated - reload
        // entitlement was recomputed with changes in grants
        if (entitlement.version !== cached.version) {
          // reload the entitlement from DB
          const { val: entitlementFromDB, err } = await this.getActiveEntitlement({
            ...params,
            opts: {
              skipCache: true, // skip cache to force revalidation from DB
            },
          })

          if (err) {
            return Err(
              new UnPriceEntitlementError({
                message: `unable to reload entitlement from DB - ${err.message}`,
              })
            )
          }

          if (!entitlementFromDB) {
            // remove the entitlement from storage
            await this.storage.delete({
              customerId: params.customerId,
              projectId: params.projectId,
              featureSlug: params.featureSlug,
            })

            return Ok(null)
          }

          // update revalidation time
          entitlementFromDB.nextRevalidateAt = params.now + this.revalidateInterval

          // set storage -> this will have the latest usage
          await this.storage.set({ state: entitlementFromDB })

          // fire a reconcile feature usage in background
          this.waitUntil(this.reconcileFeatureUsage({ state: entitlementFromDB, now: params.now }))

          return Ok(entitlementFromDB)
        }

        // update the entitlement state but preserve the current meter if version matches
        entitlementState = {
          ...entitlement,
          meter: cached.meter ?? entitlement.meter,
        }
      } catch (error) {
        const err = error as UnPriceEntitlementError
        this.logger.error(err.message, {
          ...params,
        })

        return Err(new UnPriceEntitlementError({ message: err.message }))
      }

      // Version matches - just update revalidation time and return the entitlement
      if (entitlementState) {
        entitlementState.nextRevalidateAt = params.now + this.revalidateInterval
        // set the entitlement to the storage
        await this.storage.set({ state: entitlementState })

        // Update cache and fire a reconcile feature usage in background
        this.waitUntil(this.reconcileFeatureUsage({ state: entitlementState, now: params.now }))

        return Ok(entitlementState)
      }
    }

    this.addEntitlementContext({
      state_found: true,
      cache_hit: true,
    })
    return Ok(cached)
  }

  public async resetEntitlements(params: {
    customerId: string
    projectId: string
  }): Promise<Result<void, UnPriceEntitlementError | UnPriceEntitlementStorageError>> {
    const customerId = params.customerId
    const projectId = params.projectId
    const cacheKey = `${projectId}:${customerId}`

    // reset individual keys
    const { val: entitlementsData } = await this.getActiveEntitlements({
      customerId,
      projectId,
    })

    // 2. Clear all individual feature caches
    if (entitlementsData && entitlementsData.length > 0) {
      await Promise.all(
        entitlementsData.map((e) =>
          this.cache.customerEntitlement.remove(
            this.storage.makeKey({
              customerId,
              projectId,
              featureSlug: e.featureSlug,
            })
          )
        )
      )
    }

    // reset the cache and blocked customer flag
    await Promise.all([
      this.cache.customerEntitlements.remove(cacheKey),
      this.cache.negativeEntitlements.remove(`negative:${projectId}:${customerId}:all`),
      this.customerService.invalidateAccessControlList(customerId, projectId),
      this.cache.getCurrentUsage.remove(cacheKey),
      this.storage.reset(),
      // delete the entitlements from the database
      this.db
        .delete(entitlements)
        .where(and(eq(entitlements.customerId, customerId), eq(entitlements.projectId, projectId))),
    ])

    return Ok(undefined)
  }

  public async getAccessControlList(params: {
    customerId: string
    projectId: string
    now?: number
  }): Promise<CacheNamespaces["accessControlList"]> {
    const { customerId, projectId, now } = params
    const cacheKey = `${projectId}:${customerId}`
    const { val: acl, err: aclErr } = await this.cache.accessControlList.swr(
      cacheKey,
      async (_key: string) => {
        const { val: usage, err: usageErr } = await this.getCurrentUsage({
          customerId,
          projectId,
          opts: {
            now: now,
          },
        })

        if (usageErr) {
          this.logger.error("Failed to get current usage", {
            customerId,
            projectId,
            error: usageErr.message,
          })
          return null
        }

        // if any of the groups has a usage >= limit then the customer is blocked
        // only for usage features with hard limits
        const customerUsageLimitReached = usage.groups.some((group) =>
          group.features.some(
            (feature) =>
              feature &&
              feature.type === "usage" &&
              feature.usageBar.limitType === "hard" &&
              feature.usageBar.limit !== undefined &&
              feature.usageBar.limit > 0 &&
              feature.usageBar.current >= feature.usageBar.limit
          )
        )

        // check if customer is disabled
        const [customer] = await this.db
          .select({ active: customers.active })
          .from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.projectId, projectId)))
          .limit(1)

        const customerDisabled = customer ? !customer.active : false

        // check if customer has due invoices (past due subscription)
        const [subscription] = await this.db
          .select({ status: subscriptions.status })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.customerId, customerId),
              eq(subscriptions.projectId, projectId),
              eq(subscriptions.active, true)
            )
          )
          .limit(1)

        const subscriptionStatus = subscription ? subscription.status : null

        const result = {
          customerUsageLimitReached,
          customerDisabled,
          subscriptionStatus,
        }

        return result
      }
    )

    if (aclErr) {
      this.logger.error("Failed to check if customer is blocked", {
        customerId,
        projectId,
        error: aclErr.message,
      })
      return null
    }

    return acl ?? null
  }

  /**
   * Load full entitlement from DB
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param featureSlug - Feature slug
   * @param now - Current time
   * @returns Entitlement state
   */
  private async getActiveEntitlementFromDB({
    customerId,
    projectId,
    featureSlug,
  }: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Entitlement | null> {
    const entitlement = await this.db.query.entitlements.findFirst({
      where: (e, { and, eq }) =>
        and(
          eq(e.customerId, customerId),
          eq(e.projectId, projectId),
          eq(e.featureSlug, featureSlug)
        ),
    })

    return entitlement ?? null
  }

  /**
   * Load full entitlement from DB
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param featureSlug - Feature slug
   * @param now - Current time
   * @returns Entitlement state
   */
  private async getActiveEntitlementsFromDB({
    customerId,
    projectId,
  }: {
    customerId: string
    projectId: string
  }): Promise<MinimalEntitlement[]> {
    const entitlements = await this.db.query.entitlements.findMany({
      columns: {
        id: true,
        featureSlug: true,
        effectiveAt: true,
        expiresAt: true,
      },
      where: (e, { and, eq }) => and(eq(e.customerId, customerId), eq(e.projectId, projectId)),
    })

    return entitlements
  }

  private async getActiveEntitlement({
    customerId,
    projectId,
    featureSlug,
    opts,
  }: {
    customerId: string
    projectId: string
    featureSlug: string
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
      now?: number
    }
  }): Promise<Result<EntitlementState | null, FetchError | UnPriceEntitlementError>> {
    const cacheKey = this.storage.makeKey({
      customerId,
      projectId,
      featureSlug,
    })

    // 1. Try to get the entitlement from cache, if not found try to get it from DB
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getActiveEntitlementFromDB({
            customerId,
            projectId,
            featureSlug,
          }),
          (err) =>
            new FetchError({
              message: `unable to query entitlement from db in getActiveEntitlementFromDB - ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                customerId: customerId,
                projectId: projectId,
                featureSlug: featureSlug,
                method: "getActiveEntitlementFromDB",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.customerEntitlement.swr(cacheKey, () =>
              this.getActiveEntitlementFromDB({
                customerId,
                projectId,
                featureSlug,
              })
            ),
          () => {}
        )

    if (err) {
      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    let entitlement = val

    // 2. LAZY COMPUTATION: If missing or forcing revalidation, compute from grants
    if (!entitlement) {
      const negativeCacheKey = `negative:${projectId}:${customerId}:${featureSlug}`
      let isNegative = false
      if (!opts?.skipCache) {
        const result = await this.cache.negativeEntitlements.get(negativeCacheKey)
        isNegative = result.val === true
      }

      if (isNegative) {
        return Ok(null)
      }

      const computeResult = await this.grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now: opts?.now ?? Date.now(),
      })

      if (computeResult.err) {
        return Err(new UnPriceEntitlementError({ message: computeResult.err.message }))
      }

      entitlement = computeResult.val.find((e) => e.featureSlug === featureSlug) ?? null

      // Update cache with the freshly computed entitlement
      if (entitlement !== null) {
        this.waitUntil(this.cache.customerEntitlement.set(cacheKey, entitlement!))
      } else {
        this.waitUntil(this.cache.negativeEntitlements.set(negativeCacheKey, true))
      }
    }

    if (!entitlement) return Ok(null)

    // initialize the entitlement usage
    // neve saved on cache as it changes on every usage
    const { val: meterState, err: meterStateErr } = await this.initializeUsageMeter({
      entitlement: entitlement,
      watermark: opts?.now ?? Date.now(),
    })

    if (meterStateErr) {
      return Err(
        new UnPriceEntitlementError({
          message: `unable to initialize usage meter - ${meterStateErr.message}`,
        })
      )
    }

    return Ok({
      ...entitlement,
      meter: meterState,
    })
  }

  /**
   * Checks if a timestamp falls within any active grant period
   */
  private isGrantActive(params: {
    grant: EntitlementState["grants"][number]
    now: number
  }): boolean {
    const { grant, now } = params
    const grantStart = grant.effectiveAt
    const grantEnd = grant.expiresAt ?? Number.POSITIVE_INFINITY
    return now >= grantStart && now < grantEnd
  }

  /**
   * Validates entitlement access at a specific timestamp
   * and merge the grants to get the new limits
   * @param params - Parameters
   * @param params.state - Entitlement state
   * @param params.now - Current time
   * @returns Result<EntitlementState, UnPriceEntitlementError>
   */
  private validateEntitlementState(params: {
    state: EntitlementState
    now: number
  }): Result<EntitlementState, UnPriceEntitlementError> {
    const { state, now } = params

    // check if the entitlement has not yet started
    if (state.effectiveAt && now < state.effectiveAt) {
      return Err(
        new UnPriceEntitlementError({
          message: `Entitlement not yet started for customer ${state.customerId} and project ${state.projectId} and feature ${state.featureSlug}`,
        })
      )
    }

    // check if the entitlement is expired
    if (state.expiresAt && now > state.expiresAt) {
      return Err(
        new UnPriceEntitlementError({
          message: `Entitlement expired for customer ${state.customerId} and project ${state.projectId} and feature ${state.featureSlug}`,
        })
      )
    }

    // check if grants are still active
    const activeGrants = state.grants
      .filter((grant) => this.isGrantActive({ grant, now }))
      .sort((a, b) => b.priority - a.priority)

    if (activeGrants.length === 0) {
      return Err(
        new UnPriceEntitlementError({
          message: `No active grant found for customer ${state.customerId} and project ${state.projectId} and feature ${state.featureSlug}`,
        })
      )
    }

    // with the active grants merge them to get new limits
    const mergedGrants = this.grantsManager.mergeGrants({
      grants: activeGrants,
      featureType: state.featureType,
      policy: state.mergingPolicy,
    })

    return Ok({
      ...state,
      effectiveAt: mergedGrants.effectiveAt,
      expiresAt: mergedGrants.expiresAt,
      grants: mergedGrants.grants,
    })
  }

  public async getCurrentUsage({
    customerId,
    projectId,
    opts,
  }: {
    customerId: string
    projectId: string
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
      now?: number
    }
  }): Promise<
    Result<CurrentUsage, UnPriceEntitlementError | UnPriceEntitlementStorageError | FetchError>
  > {
    const cacheKey = `${projectId}:${customerId}`

    // first try to get the entitlement from cache, if not found try to get it from DO,
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this._getCurrentUsage({
            customerId,
            projectId,
            now: opts.now ?? Date.now(),
          }),
          (err) =>
            new FetchError({
              message: `unable to query usage from _getCurrentUsage - ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                customerId: customerId,
                projectId: projectId,
                method: "_getCurrentUsage",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.getCurrentUsage.swr(cacheKey, () =>
              this._getCurrentUsage({
                customerId,
                projectId,
                now: opts?.now ?? Date.now(),
              })
            ),
          () => {}
        )

    if (err) {
      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    // set the cache with the fresh value from DB
    this.waitUntil(this.cache.getCurrentUsage.set(cacheKey, val ?? null))

    if (!val) {
      return Ok(this.buildEmptyUsageResponse("USD"))
    }

    return Ok(val)
  }

  /**
   * Get current usage data
   */
  private async _getCurrentUsage({
    customerId,
    projectId,
    now,
  }: {
    customerId: string
    projectId: string
    now: number
  }): Promise<CurrentUsage | null> {
    // Get grants and subscription info
    const grantsResult = await this.grantsManager.getGrantsForCustomer({
      customerId,
      projectId,
      now,
    })

    if (grantsResult.err) {
      this.logger.error(`Failed to get grants for customer - ${grantsResult.err.message}`, {
        customerId,
        projectId,
      })
      return null
    }

    const { grants, subscription, planVersion } = grantsResult.val

    if (grants.length === 0 || !subscription || !planVersion) {
      return this.buildEmptyUsageResponse(planVersion?.currency ?? "USD")
    }

    // Compute entitlement states first (checks DO storage for real-time usage)
    const entitlementsResult = await this.computeEntitlementStates(customerId, projectId, grants)

    if (entitlementsResult.err) {
      this.logger.error(
        `Failed to compute entitlement states - ${entitlementsResult.err.message}`,
        {
          customerId,
          projectId,
        }
      )
      return null
    }

    // Identify which features are "hot" (have real-time usage in DO) to skip analytics
    const usageOverrides = new Map<string, number>()
    for (const entitlement of entitlementsResult.val) {
      // if it has a meter and it's not the first time it's used we use it
      if (entitlement.meter.lastReconciledId !== "") {
        usageOverrides.set(entitlement.featureSlug, Number(entitlement.meter.usage))
      }
    }

    // Now get usage estimates from analytics only for "idle" features
    const usageEstimatesResult = await this.getUsageEstimates(
      customerId,
      projectId,
      now,
      usageOverrides
    )

    if (usageEstimatesResult.err) {
      this.logger.error(`Failed to get usage estimates - ${usageEstimatesResult.err.message}`, {
        customerId,
        projectId,
      })
      return null
    }

    // Build feature map and process features
    const featureMap = new Map(
      grants.map((g) => [g.featurePlanVersion.feature.slug, g.featurePlanVersion])
    )

    const features = this.buildFeatures(
      entitlementsResult.val,
      usageEstimatesResult.val,
      featureMap,
      planVersion.currency
    )

    if (features.length === 0) {
      return this.buildEmptyUsageResponse(planVersion.currency)
    }

    // Build and return response
    return this.buildUsageResponse(
      features,
      subscription,
      planVersion,
      subscription.currentCycleEndAt,
      usageEstimatesResult.val
    )
  }

  private buildEmptyUsageResponse(currency: string): CurrentUsage {
    return {
      planName: "No Plan",
      billingPeriod: "monthly",
      billingPeriodLabel: "mo",
      currency,
      groups: [],
      priceSummary: {
        totalPrice: formatMoney("0", currency),
        flatTotal: formatMoney("0", currency),
        tieredTotal: formatMoney("0", currency),
        packageTotal: formatMoney("0", currency),
        usageTotal: formatMoney("0", currency),
      },
    }
  }

  private async computeEntitlementStates(
    customerId: string,
    projectId: string,
    grants: NonNullable<
      Awaited<ReturnType<typeof this.grantsManager.getGrantsForCustomer>>["val"]
    >["grants"]
  ): Promise<Result<Omit<EntitlementState, "id">[], UnPriceEntitlementError>> {
    // Group grants by feature slug
    const grantsByFeature = new Map<string, typeof grants>()
    for (const grant of grants) {
      const slug = grant.featurePlanVersion.feature.slug
      const existing = grantsByFeature.get(slug) ?? []
      grantsByFeature.set(slug, [...existing, grant])
    }

    // Compute entitlement states for all features in parallel
    const entitlementPromises = Array.from(grantsByFeature.entries()).map(
      async ([featureSlug, featureGrants]) => {
        // Try to get from storage first (real-time source of truth in DO)
        const storageResult = await this.storage.get({
          customerId,
          projectId,
          featureSlug,
        })

        if (storageResult.val) {
          return Ok(storageResult.val)
        }

        return this.grantsManager.computeEntitlementState({
          customerId,
          projectId,
          grants: featureGrants,
        })
      }
    )

    const results = await Promise.all(entitlementPromises)

    // Check for errors and collect entitlements
    const entitlements: Omit<EntitlementState, "id">[] = []
    for (const result of results) {
      if (result.err) {
        return Err(new UnPriceEntitlementError({ message: result.err.message }))
      }

      // if it has a meter (meaning it was loaded from storage) we use it
      if ("meter" in result.val) {
        entitlements.push(result.val as Omit<EntitlementState, "id">)
      } else {
        entitlements.push({
          ...result.val,
          meter: {
            usage: "0",
            snapshotUsage: "0",
            lastReconciledId: "",
            lastUpdated: Date.now(),
            lastCycleStart: undefined,
          },
        })
      }
    }

    return Ok(entitlements)
  }

  private async getUsageEstimates(
    customerId: string,
    projectId: string,
    now: number,
    usageOverrides?: Map<string, number>
  ): Promise<
    Result<
      Awaited<ReturnType<BillingService["estimatePriceCurrentUsage"]>>["val"],
      UnPriceEntitlementError
    >
  > {
    const billingService = new BillingService({
      db: this.db,
      logger: this.logger,
      analytics: this.analytics,
      waitUntil: this.waitUntil,
      cache: this.cache,
      metrics: this.metrics,
    })

    const result = await billingService.estimatePriceCurrentUsage({
      customerId,
      projectId,
      now,
      usageOverrides,
    })

    return result.err
      ? Err(new UnPriceEntitlementError({ message: result.err.message }))
      : Ok(result.val)
  }

  private buildFeatures(
    entitlements: Omit<EntitlementState, "id">[],
    usageEstimates: Awaited<ReturnType<BillingService["estimatePriceCurrentUsage"]>>["val"],
    featureMap: Map<
      string,
      NonNullable<
        Awaited<ReturnType<typeof this.grantsManager.getGrantsForCustomer>>["val"]
      >["grants"][number]["featurePlanVersion"]
    >,
    currency: Currency
  ) {
    const grantIds = new Set(usageEstimates?.map((u) => u.grantId) ?? [])

    return (
      entitlements
        .map((entitlement) => {
          const planVersionFeature = featureMap.get(entitlement.featureSlug)
          if (!planVersionFeature) return null

          // Find matching usage estimates by grant ID
          const usageGrants = (usageEstimates ?? []).filter((u) =>
            entitlement.grants.some((g) => g.id === u.grantId && grantIds.has(u.grantId ?? ""))
          )

          // Aggregate usage data
          // Prioritize real-time usage from DO storage if available (lastReconciledId is present)
          const meterUsage = Number(entitlement.meter.usage)
          const usage =
            entitlement.meter.lastReconciledId !== ""
              ? meterUsage
              : usageGrants.reduce((acc, u) => acc + u.usage, 0)

          const included = usageGrants.reduce((acc, u) => acc + u.included, 0)

          // TODO: sloppy, we should use the currency from the plan version feature
          const zeroDinero = dinero({
            amount: 0,
            currency: currencies[currency as keyof typeof currencies],
          })

          // Sum prices from usageEstimates (already formatted strings, need to parse to sum)
          const totalPriceDinero = usageGrants.reduce(
            (acc, u) => add(acc, u.price.totalPrice.dinero),
            zeroDinero
          )

          return {
            entitlement,
            planVersionFeature,
            usage,
            included,
            totalPriceDinero,
            limit: entitlement.limit,
          }
        })
        .filter((f): f is NonNullable<typeof f> => f !== null)
        // order by feature type and price
        .sort((a, b) => {
          if (a.entitlement.featureSlug < b.entitlement.featureSlug) return -1
          if (a.entitlement.featureSlug > b.entitlement.featureSlug) return 1
          const aPrice = a.totalPriceDinero.toJSON().amount
          const bPrice = b.totalPriceDinero.toJSON().amount
          return bPrice - aPrice
        })
    )
  }

  private buildUsageResponse(
    features: ReturnType<typeof this.buildFeatures>,
    subscription: NonNullable<
      NonNullable<
        Awaited<ReturnType<typeof this.grantsManager.getGrantsForCustomer>>["val"]
      >["subscription"]
    >,
    planVersion: NonNullable<
      NonNullable<
        Awaited<ReturnType<typeof this.grantsManager.getGrantsForCustomer>>["val"]
      >["planVersion"]
    >,
    cycleEndAt: number,
    usageEstimates: Awaited<ReturnType<BillingService["estimatePriceCurrentUsage"]>>["val"]
  ): CurrentUsage {
    const billingConfig = planVersion.billingConfig
    const billingPeriod = billingConfig.name
    const currency = planVersion.currency

    // Format renewal date
    const date = toZonedTime(new Date(cycleEndAt), subscription.timezone)
    const renewalDate =
      billingConfig.billingInterval === "minute"
        ? format(date, "MMMM d, yyyy hh:mm a")
        : format(date, "MMMM d, yyyy")

    const daysRemaining = Math.ceil((cycleEndAt - Date.now()) / (1000 * 60 * 60 * 24))

    // Build feature displays ordered by feature type
    // firt flat, then tiered, then package, then usage
    const displayFeatures = features
      .sort((a, b) => {
        if (a.entitlement.featureType === "flat") return -1
        if (b.entitlement.featureType === "flat") return 1
        if (a.entitlement.featureType === "tier") return -1
        if (b.entitlement.featureType === "tier") return 1
        if (a.entitlement.featureType === "package") return -1
        if (b.entitlement.featureType === "package") return 1
        if (a.entitlement.featureType === "usage") return -1
        if (b.entitlement.featureType === "usage") return 1
        return 0
      })
      .map((f) => this.buildFeatureDisplay(f, planVersion))

    // Use prices directly from usageEstimates using dinero objects
    // Group by feature type by matching grants to features
    const grantToFeatureType = new Map<string, string>()
    for (const feature of features) {
      for (const grant of feature.entitlement.grants) {
        grantToFeatureType.set(grant.id, feature.entitlement.featureType)
      }
    }

    // Initialize dinero totals with zero (using basePrice currency)
    const zeroDinero = dinero({ amount: 0, currency: currencies[currency] })
    let flatTotalDinero: Dinero<number> = zeroDinero
    let tieredTotalDinero: Dinero<number> = zeroDinero
    let packageTotalDinero: Dinero<number> = zeroDinero
    let usageTotalDinero: Dinero<number> = zeroDinero

    // Sum prices from usageEstimates by feature type using dinero
    for (const estimate of usageEstimates ?? []) {
      if (!estimate.grantId || !estimate.price.totalPrice.dinero) continue
      const featureType = grantToFeatureType.get(estimate.grantId)
      if (!featureType) continue

      if (featureType === "flat") {
        flatTotalDinero = add(flatTotalDinero, estimate.price.totalPrice.dinero)
      } else if (featureType === "tier") {
        tieredTotalDinero = add(tieredTotalDinero, estimate.price.totalPrice.dinero)
      } else if (featureType === "usage") {
        usageTotalDinero = add(usageTotalDinero, estimate.price.totalPrice.dinero)
      } else if (featureType === "package") {
        packageTotalDinero = add(packageTotalDinero, estimate.price.totalPrice.dinero)
      }
    }

    // Calculate total price using dinero
    const totalPriceDinero = add(
      add(add(flatTotalDinero, tieredTotalDinero), packageTotalDinero),
      usageTotalDinero
    )

    // Format prices from dinero (basePrice is already formatted, so we only format the totals)
    const flatTotal = toDecimal(flatTotalDinero, ({ value, currency }) =>
      formatMoney(value.toString(), currency.code)
    )
    const tieredTotal = toDecimal(tieredTotalDinero, ({ value, currency }) =>
      formatMoney(value.toString(), currency.code)
    )
    const usageTotal = toDecimal(usageTotalDinero, ({ value, currency }) =>
      formatMoney(value.toString(), currency.code)
    )
    const packageTotal = toDecimal(packageTotalDinero, ({ value, currency }) =>
      formatMoney(value.toString(), currency.code)
    )
    const totalPrice = toDecimal(totalPriceDinero, ({ value, currency }) =>
      formatMoney(value.toString(), currency.code)
    )

    return {
      planName: subscription.planSlug ?? "No Plan",
      planDescription: planVersion.description ?? undefined,
      billingPeriod,
      billingPeriodLabel: billingPeriod,
      currency,
      renewalDate,
      daysRemaining: daysRemaining > 0 ? daysRemaining : undefined,
      groups: [
        {
          id: "all-features",
          name: "Features",
          featureCount: features.length,
          features: displayFeatures,
        },
      ],
      priceSummary: {
        totalPrice,
        flatTotal,
        tieredTotal,
        packageTotal,
        usageTotal,
      },
    }
  }

  private buildFeatureDisplay(
    feature: NonNullable<ReturnType<typeof this.buildFeatures>[number]>,
    planVersion: NonNullable<
      NonNullable<
        Awaited<ReturnType<typeof this.grantsManager.getGrantsForCustomer>>["val"]
      >["planVersion"]
    >
  ): CurrentUsage["groups"][number]["features"][number] {
    const { entitlement, planVersionFeature, usage, included, totalPriceDinero, limit } = feature

    const featureType = entitlement.featureType
    const billingFrequencyLabel = planVersionFeature.billingConfig.name
    const resetFrequencyLabel = planVersionFeature.resetConfig?.name ?? billingFrequencyLabel

    // Format price as string (price comes from usageEstimates)
    const priceString = toDecimal(totalPriceDinero, ({ value, currency }) =>
      formatMoney(value.toString(), currency.code)
    )

    const baseFeature = {
      id: entitlement.featureSlug,
      name: planVersionFeature.feature.title ?? entitlement.featureSlug,
      description: planVersionFeature.feature.description ?? undefined,
      price: priceString,
    }

    if (featureType === "flat") {
      return {
        ...baseFeature,
        type: "flat" as const,
        typeLabel: "Flat",
        enabled: (limit ?? 0) > 0,
        currency: planVersion.currency,
        billing: {
          billingFrequencyLabel,
          resetFrequencyLabel,
        },
      }
    }

    if (featureType === "tier") {
      const config = planVersionFeature.config as { tiers?: Array<unknown> } | undefined
      const tiers =
        (config?.tiers as Array<{
          firstUnit: number
          lastUnit: number | null
          unitPrice: { displayAmount: string }
          label?: string
        }>) ?? []

      const formattedTiers = tiers.map((tier, index) => ({
        min: tier.firstUnit,
        max: tier.lastUnit,
        pricePerUnit: Number.parseFloat(tier.unitPrice?.displayAmount ?? "0"),
        label: tier.label ?? `Tier ${index + 1}`,
        isActive: usage >= tier.firstUnit && (tier.lastUnit === null || usage <= tier.lastUnit),
      }))

      return {
        ...baseFeature,
        type: "tiered" as const,
        typeLabel: "Tiered",
        currency: planVersion.currency,
        billing: { billingFrequencyLabel, resetFrequencyLabel },
        tieredDisplay: {
          currentUsage: usage,
          billableUsage: Math.max(0, usage - included),
          unit: planVersionFeature.feature.unit ?? "units",
          freeAmount: included,
          tiers: formattedTiers,
          currentTierLabel: formattedTiers.find((t) => t.isActive)?.label,
        },
      }
    }

    // Usage type
    const isHardLimit =
      planVersionFeature.metadata?.overageStrategy === "none" ||
      planVersionFeature.metadata?.overageStrategy === "last-call"

    return {
      ...baseFeature,
      type: "usage" as const,
      typeLabel: "Usage",
      currency: planVersion.currency,
      billing: {
        billingFrequencyLabel,
        resetFrequencyLabel,
      },
      usageBar: {
        current: usage,
        included,
        limit: limit ?? undefined,
        limitType: isHardLimit ? "hard" : "soft",
        unit: planVersionFeature.feature.unit ?? "units",
        notifyThreshold: planVersionFeature.metadata?.notifyUsageThreshold ?? 95,
        overageStrategy: planVersionFeature.metadata?.overageStrategy ?? "none",
      },
    }
  }
}
