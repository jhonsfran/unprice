import type { Analytics } from "@unprice/analytics"
import { type Database, and, eq } from "@unprice/db"
import { add, currencies, dinero, newId, toDecimal } from "@unprice/db/utils"
import type { Dinero } from "@unprice/db/utils"
import type { Currency, CurrentUsage, EntitlementState } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger, WideEventInput } from "@unprice/logs"
import { formatMoney } from "@unprice/money"
import { format } from "date-fns"
import { toZonedTime } from "date-fns-tz"
import type { BillingService } from "../billing"
import type { CacheNamespaces } from "../cache/namespaces"
import type { Cache } from "../cache/service"
import type { CustomerService } from "../customers/service"
import type { Metrics } from "../metrics"
import { cachedQuery } from "../utils/cached-query"
import { toErrorContext } from "../utils/log-context"
import { UnPriceEntitlementError } from "./errors"
import type { GrantsManager } from "./grants"

import { customers, subscriptions } from "@unprice/db/schema"
import { deriveLimitType } from "./policy"

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
  private readonly db: Database
  private readonly logger: Logger
  private readonly analytics: Analytics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private readonly cache: Cache
  private readonly metrics: Metrics
  private readonly customerService: CustomerService
  private readonly billingService: BillingService

  constructor(opts: {
    db: Database
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
    customerService: CustomerService
    grantsManager: GrantsManager
    billingService: BillingService
  }) {
    this.grantsManager = opts.grantsManager
    this.db = opts.db
    this.logger = opts.logger
    this.analytics = opts.analytics
    this.waitUntil = opts.waitUntil
    this.cache = opts.cache
    this.metrics = opts.metrics
    this.customerService = opts.customerService
    this.billingService = opts.billingService
  }

  private addBusinessContext(context: WideEventInput["business"]) {
    this.logger.set({ business: context })
  }

  /**
   * Helper to add structured entitlement context to wide events.
   * Groups everything under "entitlements" key for clear identification in logs.
   * Keeps only essential information for debugging.
   */
  private addEntitlementContext(context: WideEventInput["entitlements"]) {
    this.logger.set({ entitlements: context })
  }

  /**
   * Compute entitlements directly from grants (source of truth).
   * This avoids drift between the materialized entitlements table and the grants table.
   */
  private async computeEntitlementsFromGrants({
    projectId,
    customerId,
    historicalDays = 30,
  }: {
    projectId: string
    customerId: string
    historicalDays?: number
  }): Promise<CacheNamespaces["customerRelevantEntitlements"]> {
    const now = Date.now()

    // Use time range to include historical grants for late reporting,
    // or point-in-time for current-only queries
    const grantsResult =
      historicalDays > 0
        ? await this.grantsManager.getGrantsForCustomer({
            customerId,
            projectId,
            startAt: now - historicalDays * 24 * 60 * 60 * 1000,
            endAt: now,
          })
        : await this.grantsManager.getGrantsForCustomer({
            customerId,
            projectId,
            now,
          })

    if (grantsResult.err) {
      this.logger.debug("No grants found for customer", {
        customerId,
        projectId,
        error: grantsResult.err.message,
      })
      return []
    }

    const { grants } = grantsResult.val

    if (grants.length === 0) {
      return []
    }

    // Group grants by feature slug
    const grantsByFeature = new Map<string, typeof grants>()
    for (const grant of grants) {
      const slug = grant.featurePlanVersion.feature.slug
      const existing = grantsByFeature.get(slug) ?? []
      grantsByFeature.set(slug, [...existing, grant])
    }

    // Compute entitlement state for each feature
    const entitlements: CacheNamespaces["customerRelevantEntitlements"] = []

    for (const [slug, featureGrants] of grantsByFeature) {
      const result = await this.grantsManager.computeEntitlementState({
        customerId,
        projectId,
        grants: featureGrants,
      })

      if (result.err) {
        this.logger.warn("Failed to compute entitlement state for feature", {
          customerId,
          projectId,
          featureSlug: slug,
          error: result.err.message,
        })
        continue
      }

      entitlements.push({
        ...result.val,
        id: newId("entitlement"),
      })
    }

    return entitlements
  }

  public async getRelevantEntitlementsForIngestion({
    projectId,
    customerId,
    historicalDays = 30,
    opts,
  }: {
    projectId: string
    customerId: string
    historicalDays?: number
    opts?: {
      skipCache?: boolean
    }
  }): Promise<Result<CacheNamespaces["customerRelevantEntitlements"], FetchError>> {
    const cacheKey = `${projectId}:${customerId}:${historicalDays}`

    const { val, err } = await cachedQuery({
      skipCache: opts?.skipCache,
      cache: this.cache.customerRelevantEntitlements,
      cacheKey,
      load: () =>
        this.computeEntitlementsFromGrants({
          projectId,
          customerId,
          historicalDays,
        }),
      wrapLoadError: (error) =>
        new FetchError({
          message: `unable to compute entitlements from grants - ${error.message}`,
          retry: false,
          context: {
            error: error.message,
            url: "",
            customerId,
            projectId,
            method: "computeEntitlementsFromGrants",
          },
        }),
    })

    if (err) {
      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    return Ok(val ?? [])
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
          this.logger.error(usageErr, {
            customerId,
            projectId,
            context: "Failed to get current usage",
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
      this.logger.error(aclErr, {
        customerId,
        projectId,
        context: "Failed to check if customer is blocked",
      })
      return null
    }

    return acl ?? null
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
  }): Promise<Result<CurrentUsage, UnPriceEntitlementError | FetchError>> {
    const cacheKey = `${projectId}:${customerId}`

    // first try to get the entitlement from cache, if not found try to get it from DO,
    const { val, err } = await cachedQuery({
      skipCache: opts?.skipCache,
      cache: this.cache.getCurrentUsage,
      cacheKey,
      load: () =>
        this._getCurrentUsage({
          customerId,
          projectId,
          now: opts?.now ?? Date.now(),
        }),
      wrapLoadError: (err) =>
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
        }),
    })

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
      async ([_, featureGrants]) => {
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
    const result = await this.billingService.estimatePriceCurrentUsage({
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
          const zeroDinero: import("dinero.js").Dinero<number> = dinero({
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
          unit: planVersionFeature.unitOfMeasure ?? "units",
          freeAmount: included,
          tiers: formattedTiers,
          currentTierLabel: formattedTiers.find((t) => t.isActive)?.label,
        },
      }
    }

    // Usage type
    const overageStrategy = planVersionFeature.metadata?.overageStrategy ?? "none"
    const limitType = deriveLimitType({
      limit,
      overageStrategy,
    })

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
        limitType,
        unit: planVersionFeature.unitOfMeasure ?? "units",
        notifyThreshold: planVersionFeature.metadata?.notifyUsageThreshold ?? 95,
        overageStrategy,
      },
    }
  }
}
