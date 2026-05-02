import type { Analytics } from "@unprice/analytics"
import { add, currencies, dinero, toDecimal } from "@unprice/db/utils"
import {
  type CalculatedPrice,
  type Currency,
  type Entitlement,
  type EntitlementState,
  calculateCycleWindow,
  calculateFreeUnits,
  calculateProration,
  calculateWaterfallPrice,
  type configFeatureSchema,
  type grantSchemaExtended,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { formatMoney } from "@unprice/money"
import { subtract, toSnapshot } from "dinero.js"
import type { z } from "zod"
import type { GrantsManager } from "../entitlements"
import { toErrorContext } from "../utils/log-context"
import { UnPriceRatingError } from "./errors"
import type {
  BillingWindow,
  IncrementalRatingInput,
  IncrementalRatingResult,
  RatedCharge,
  RatingInput,
  ResolveBillingWindowInput,
  UsageFeatureData,
} from "./types"

export class RatingService {
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly grantsManager: GrantsManager

  constructor({
    logger,
    analytics,
    grantsManager,
  }: {
    logger: Logger
    analytics: Analytics
    grantsManager: GrantsManager
  }) {
    this.logger = logger
    this.analytics = analytics
    this.grantsManager = grantsManager
  }

  /**
   * Calculates the billing window based on entitlement state and time parameters.
   * Handles both 'now' and explicit startAt/endAt scenarios.
   */
  public resolveBillingWindow({
    entitlement,
    now,
    startAt,
    endAt,
  }: ResolveBillingWindowInput): Result<BillingWindow, UnPriceRatingError> {
    const resetConfig = entitlement.resetConfig

    // If explicit dates provided, use them
    if (startAt !== undefined && endAt !== undefined) {
      if (startAt >= endAt) {
        return Err(
          new UnPriceRatingError({
            message: `Invalid billing window: startAt (${startAt}) must be before endAt (${endAt})`,
          })
        )
      }
      return Ok({ billingStartAt: startAt, billingEndAt: endAt })
    }

    // Calculate from 'now' if provided
    if (now !== undefined) {
      if (resetConfig) {
        const cycleWindow = calculateCycleWindow({
          now,
          effectiveStartDate: entitlement.effectiveAt,
          effectiveEndDate: entitlement.expiresAt,
          config: {
            name: resetConfig.name,
            interval: resetConfig.resetInterval,
            intervalCount: resetConfig.resetIntervalCount,
            planType: resetConfig.planType,
            anchor: resetConfig.resetAnchor,
          },
          trialEndsAt: null,
        })

        if (cycleWindow) {
          return Ok({
            billingStartAt: cycleWindow.start,
            billingEndAt: cycleWindow.end,
          })
        }
      }

      // Fallback: use grant effective dates
      const billingStartAt = entitlement.effectiveAt
      // max int64 that represent the max date
      const billingEndAt = entitlement.expiresAt ?? new Date("9999-12-31").getTime()

      if (billingStartAt >= billingEndAt) {
        return Err(
          new UnPriceRatingError({
            message: `Invalid billing window: startAt (${billingStartAt}) must be before endAt (${billingEndAt})`,
          })
        )
      }

      return Ok({ billingStartAt, billingEndAt })
    }

    return Err(
      new UnPriceRatingError({
        message: "Either 'now' or both 'startAt' and 'endAt' must be provided",
      })
    )
  }

  /**
   * Calculates usage data for features based on grants, entitlement state, and billing window.
   * This method handles fetching usage data (if not provided) and computing total usage amounts.
   *
   * @returns Object containing usage information including usage, and isUsageFeature flag
   */
  private async calculateUsageOfFeatures({
    projectId,
    customerId,
    featureSlug,
    entitlement,
    billingStartAt,
    billingEndAt,
    usageData: providedUsageData,
  }: {
    projectId: string
    customerId: string
    featureSlug: string
    entitlement: Omit<Entitlement, "id">
    billingStartAt: number
    billingEndAt: number
    usageData?: UsageFeatureData[]
  }): Promise<
    Result<
      {
        usage: number
        isUsageFeature: boolean
      },
      UnPriceRatingError
    >
  > {
    // Validate billing window
    if (billingStartAt >= billingEndAt) {
      return Err(
        new UnPriceRatingError({
          message: `Invalid billing window: startAt (${billingStartAt}) must be before endAt (${billingEndAt})`,
        })
      )
    }

    const featureType = entitlement.featureType
    const aggregationMethod = entitlement.meterConfig?.aggregationMethod
    const isUsageFeature = featureType === "usage"

    // For non-usage features we only use explicit usage overrides (event-time rating path).
    // Existing periodic callers that do not pass overrides preserve current behavior (0 usage).
    if (!isUsageFeature) {
      const overriddenUsage =
        providedUsageData?.find((u) => u.featureSlug === featureSlug)?.usage ?? 0
      return Ok({
        usage: overriddenUsage,
        isUsageFeature: false,
      })
    }

    if (!aggregationMethod) {
      return Err(
        new UnPriceRatingError({
          message: `Usage feature ${featureSlug} is missing an aggregation method`,
        })
      )
    }

    // Use provided usage data if available, otherwise fetch it
    let usageData: UsageFeatureData[]
    if (providedUsageData && providedUsageData.length > 0) {
      usageData = providedUsageData
    } else {
      // Fetch TOTAL usage for this feature (no grant filtering)
      const { err: usageErr, val: fetchedUsageData } = await this.analytics.getUsageBillingFeatures(
        {
          customerId,
          projectId,
          features: [
            {
              featureSlug,
              aggregationMethod,
              featureType,
            },
          ],
          startAt: billingStartAt,
          endAt: billingEndAt,
        }
      )

      if (usageErr) {
        this.logger.error(usageErr, {
          featureSlug,
          customerId,
          projectId,
          billingStartAt,
          billingEndAt,
          context: "Failed to get usage for feature",
        })
        return Err(new UnPriceRatingError({ message: usageErr.message }))
      }

      usageData = fetchedUsageData
    }

    // Extract usage values for the specific feature
    const featureUsage = usageData.find((u) => u.featureSlug === featureSlug)
    const currentCycleUsage = featureUsage?.usage ?? 0

    return Ok({
      usage: currentCycleUsage,
      isUsageFeature: true,
    })
  }

  /**
   * Calculates proration for a grant within a billing window.
   */
  private calculateGrantProration({
    grant,
    billingStartAt,
    billingEndAt,
    resetConfig,
  }: {
    grant: z.infer<typeof grantSchemaExtended>
    billingStartAt: number
    billingEndAt: number
    resetConfig: Omit<EntitlementState, "id">["resetConfig"]
  }): { prorationFactor: number; referenceCycleStart: number; referenceCycleEnd: number } {
    // Calculate proration based on the billing period
    // The service window is the intersection of the grant active period and the billing cycle
    const grantServiceStart = Math.max(billingStartAt, grant.effectiveAt)
    const grantServiceEnd = Math.min(billingEndAt, grant.expiresAt ?? Number.POSITIVE_INFINITY)

    // if grant is trial, proration factor should be 0
    if (grant.type === "trial") {
      return {
        prorationFactor: 0,
        referenceCycleStart: grantServiceStart,
        referenceCycleEnd: grantServiceEnd,
      }
    }

    if (resetConfig) {
      const proration = calculateProration({
        serviceStart: grantServiceStart,
        serviceEnd: grantServiceEnd,
        effectiveStartDate: grant.effectiveAt, // used for anchor calculation
        billingConfig: {
          name: resetConfig.name,
          billingInterval: resetConfig.resetInterval,
          billingIntervalCount: resetConfig.resetIntervalCount,
          planType: resetConfig.planType,
          billingAnchor: resetConfig.resetAnchor,
        },
      })
      return proration
    }

    return {
      prorationFactor: 1,
      referenceCycleStart: grantServiceStart,
      referenceCycleEnd: grantServiceEnd,
    }
  }

  private entitlementFromGrant(
    grant: z.infer<typeof grantSchemaExtended>
  ): Omit<Entitlement, "id"> {
    const customerEntitlement = grant.customerEntitlement
    const featurePlanVersion = customerEntitlement.featurePlanVersion
    const resetConfig = featurePlanVersion.resetConfig

    return {
      limit: customerEntitlement.allowanceUnits,
      mergingPolicy: "replace",
      effectiveAt: customerEntitlement.effectiveAt,
      expiresAt: customerEntitlement.expiresAt,
      resetConfig: resetConfig
        ? {
            ...resetConfig,
            resetAnchor: typeof resetConfig.resetAnchor === "number" ? resetConfig.resetAnchor : 0,
          }
        : null,
      meterConfig:
        featurePlanVersion.featureType === "usage"
          ? (featurePlanVersion.meterConfig ?? null)
          : null,
      featureType: featurePlanVersion.featureType,
      unitOfMeasure: featurePlanVersion.unitOfMeasure,
      grants: [],
      featureSlug: featurePlanVersion.feature.slug,
      customerId: customerEntitlement.customerId,
      projectId: customerEntitlement.projectId,
      isCurrent: true,
      createdAtM: customerEntitlement.createdAtM,
      updatedAtM: customerEntitlement.updatedAtM,
      metadata: {
        realtime: featurePlanVersion.metadata?.realtime ?? false,
        notifyUsageThreshold: featurePlanVersion.metadata?.notifyUsageThreshold ?? 90,
        overageStrategy: customerEntitlement.overageStrategy,
        blockCustomer: featurePlanVersion.metadata?.blockCustomer ?? false,
        hidden: featurePlanVersion.metadata?.hidden ?? false,
      },
    }
  }

  private resolveCurrency(
    explicitCurrency: Currency | undefined,
    charges: RatedCharge[],
    grants: z.infer<typeof grantSchemaExtended>[]
  ) {
    if (explicitCurrency) {
      const code = explicitCurrency as string
      if (code in currencies) {
        return currencies[code as keyof typeof currencies]
      }
    }

    const fromCharge = charges.find((c) => c.price.totalPrice.dinero)?.price.totalPrice.dinero
    if (fromCharge) {
      return toSnapshot(fromCharge).currency
    }

    for (const grant of grants) {
      const cfg = grant.customerEntitlement.featurePlanVersion.config
      // Try tiers first (tier pricing stores currency per tier)
      const tierCurrency = cfg?.tiers?.[0]?.unitPrice?.dinero?.currency?.code
      if (tierCurrency && tierCurrency in currencies) {
        return currencies[tierCurrency as keyof typeof currencies]
      }
      // Then flat/unit/package price
      const priceCurrency = cfg?.price?.dinero?.currency?.code
      if (priceCurrency && priceCurrency in currencies) {
        return currencies[priceCurrency as keyof typeof currencies]
      }
    }

    this.logger.warn("Could not determine currency from grants or charges, falling back to USD")
    return currencies.USD
  }

  private asCalculatedPrice(
    unitPriceDinero: CalculatedPrice["unitPrice"]["dinero"],
    subtotalPriceDinero: CalculatedPrice["subtotalPrice"]["dinero"],
    totalPriceDinero: CalculatedPrice["totalPrice"]["dinero"]
  ): CalculatedPrice {
    const toPrice = (value: CalculatedPrice["totalPrice"]["dinero"]) => ({
      dinero: value,
      displayAmount: toDecimal(
        value,
        ({ value: amount, currency }) => `${formatMoney(amount, currency.code)}`
      ),
    })

    return {
      unitPrice: toPrice(unitPriceDinero),
      subtotalPrice: toPrice(subtotalPriceDinero),
      totalPrice: toPrice(totalPriceDinero),
    }
  }

  private aggregateCalculatedPrice(
    charges: RatedCharge[],
    fallbackCurrency: ReturnType<typeof this.resolveCurrency>
  ): CalculatedPrice {
    const zero = dinero({ amount: 0, currency: fallbackCurrency })
    const unitPriceDinero = charges.reduce(
      (sum, charge) => add(sum, charge.price.unitPrice.dinero),
      zero
    )
    const subtotalPriceDinero = charges.reduce(
      (sum, charge) => add(sum, charge.price.subtotalPrice.dinero),
      zero
    )
    const totalPriceDinero = charges.reduce(
      (sum, charge) => add(sum, charge.price.totalPrice.dinero),
      zero
    )

    return this.asCalculatedPrice(unitPriceDinero, subtotalPriceDinero, totalPriceDinero)
  }

  /**
   * Calculates the price for a feature based on grants, usage, and billing period.
   * Handles waterfall attribution of usage across multiple grants and calculates proration.
   */
  public async rateBillingPeriod(
    params: RatingInput
  ): Promise<Result<RatedCharge[], UnPriceRatingError>> {
    const {
      projectId,
      customerId,
      featureSlug,
      grants: providedGrants,
      entitlement: providedEntitlement,
      usageData: providedUsageData,
    } = params
    const now = "now" in params ? params.now : undefined
    const startAt = "startAt" in params ? params.startAt : undefined
    const endAt = "endAt" in params ? params.endAt : undefined

    // Validate required parameters
    if (!projectId || !customerId || !featureSlug) {
      return Err(
        new UnPriceRatingError({
          message: "Missing required parameters: projectId, customerId, or featureSlug",
        })
      )
    }

    const grants = providedGrants ?? []

    if (grants.length === 0) {
      return Ok([])
    }

    const entitlement = providedEntitlement ?? this.entitlementFromGrant(grants[0]!)

    // Calculate billing window
    const billingWindowInput: ResolveBillingWindowInput =
      startAt !== undefined && endAt !== undefined
        ? { entitlement, startAt, endAt }
        : { entitlement, now: now! }
    const billingWindowResult = this.resolveBillingWindow(billingWindowInput)

    if (billingWindowResult.err) {
      return Err(billingWindowResult.err)
    }

    const { billingStartAt, billingEndAt } = billingWindowResult.val

    // Calculate usage
    const usageResult = await this.calculateUsageOfFeatures({
      projectId,
      customerId,
      featureSlug,
      entitlement,
      billingStartAt,
      billingEndAt,
      usageData: providedUsageData,
    })

    if (usageResult.err) {
      return Err(usageResult.err)
    }

    const { usage } = usageResult.val

    // Track remaining usage for waterfall attribution
    const pricingGrants: Array<{
      id: string
      limit?: number | null
      priority?: number | null
      config: z.infer<typeof configFeatureSchema>
      prorate?: number
    }> = []

    const grantMetadata = new Map<
      string,
      {
        cycleStartAt: number
        cycleEndAt: number
        included: number
        isTrial: boolean
        limit: number
        prorate: number
      }
    >()

    // Prepare grants for waterfall calculation
    for (const grant of grants) {
      const grantServiceStart = Math.max(billingStartAt, grant.effectiveAt)
      const grantServiceEnd = Math.min(billingEndAt, grant.expiresAt ?? Number.POSITIVE_INFINITY)

      // Validate grant service window
      if (grantServiceStart >= grantServiceEnd) {
        continue
      }

      const grantLimit = grant.allowanceUnits ?? Number.POSITIVE_INFINITY

      // Calculate proration
      const proration = this.calculateGrantProration({
        grant,
        billingStartAt,
        billingEndAt,
        resetConfig: entitlement.resetConfig,
      })

      // Calculate free units
      const freeUnitsResult = calculateFreeUnits({
        config: grant.customerEntitlement.featurePlanVersion.config,
        featureType: grant.customerEntitlement.featurePlanVersion.featureType,
      })

      if (freeUnitsResult.err) {
        this.logger.warn("Failed to calculate free units for grant", {
          grantId: grant.id,
          featureSlug,
          error: toErrorContext(freeUnitsResult.err),
        })
      }

      const freeUnits = freeUnitsResult.val ?? 0

      pricingGrants.push({
        id: grant.id,
        limit: grant.allowanceUnits,
        priority: grant.priority,
        config: grant.customerEntitlement.featurePlanVersion.config,
        prorate: proration.prorationFactor,
      })

      grantMetadata.set(grant.id, {
        cycleStartAt: proration.referenceCycleStart,
        cycleEndAt: proration.referenceCycleEnd,
        included: freeUnits,
        isTrial: grant.type === "trial",
        limit: grantLimit,
        prorate: proration.prorationFactor,
      })
    }

    // Call waterfall calculation
    const waterfallResult = calculateWaterfallPrice({
      grants: pricingGrants,
      usage,
      featureType: entitlement.featureType,
    })

    if (waterfallResult.err) {
      return Err(new UnPriceRatingError({ message: waterfallResult.err.message }))
    }

    const result: RatedCharge[] = []

    for (const item of waterfallResult.val.items) {
      if (item.grantId) {
        const metadata = grantMetadata.get(item.grantId)
        if (metadata) {
          result.push({
            grantId: item.grantId,
            price: item.price,
            prorate: metadata.prorate,
            cycleStartAt: metadata.cycleStartAt,
            cycleEndAt: metadata.cycleEndAt,
            usage: item.usage,
            included: metadata.included,
            limit: metadata.limit,
            isTrial: metadata.isTrial,
          })
        }
      } else {
        // Unattributed usage
        result.push({
          grantId: null,
          price: item.price,
          prorate: 1,
          cycleStartAt: billingStartAt,
          cycleEndAt: billingEndAt,
          usage: item.usage,
          included: 0,
          limit: 0,
          isTrial: false,
        })
      }
    }

    return Ok(result)
  }

  public async rateIncrementalUsage(
    params: IncrementalRatingInput
  ): Promise<Result<IncrementalRatingResult, UnPriceRatingError>> {
    const { projectId, customerId, featureSlug, usageBefore, usageAfter } = params

    if (!projectId || !customerId || !featureSlug) {
      return Err(
        new UnPriceRatingError({
          message: "Missing required parameters: projectId, customerId, or featureSlug",
        })
      )
    }

    if (
      !Number.isFinite(usageBefore) ||
      !Number.isFinite(usageAfter) ||
      usageBefore < 0 ||
      usageAfter < 0
    ) {
      return Err(
        new UnPriceRatingError({
          message:
            "usageBefore and usageAfter must be finite numbers greater than or equal to zero",
        })
      )
    }

    const grants = params.grants ?? []

    if (!params.entitlement && grants.length === 0) {
      const currency = this.resolveCurrency(params.currency, [], grants)
      const zero = dinero({ amount: 0, currency })
      const zeroPrice = this.asCalculatedPrice(zero, zero, zero)
      return Ok({
        usageBefore,
        usageAfter,
        usageDelta: usageAfter - usageBefore,
        before: [],
        after: [],
        deltaPrice: zeroPrice,
      })
    }

    const entitlement = params.entitlement ?? this.entitlementFromGrant(grants[0]!)

    const buildRatingInput = (usageData: UsageFeatureData[]): RatingInput => {
      if (params.now !== undefined) {
        return {
          projectId,
          customerId,
          featureSlug,
          now: params.now,
          grants,
          entitlement,
          usageData,
        }
      }

      return {
        projectId,
        customerId,
        featureSlug,
        startAt: params.startAt,
        endAt: params.endAt,
        grants,
        entitlement,
        usageData,
      }
    }

    const beforeInput = buildRatingInput(
      params.usageDataBefore ?? [{ featureSlug, usage: usageBefore }]
    )
    const afterInput = buildRatingInput(
      params.usageDataAfter ?? [{ featureSlug, usage: usageAfter }]
    )

    // Run before and after rating in parallel — they are independent
    const [beforeResult, afterResult] = await Promise.all([
      this.rateBillingPeriod(beforeInput),
      this.rateBillingPeriod(afterInput),
    ])

    if (beforeResult.err) {
      return Err(beforeResult.err)
    }

    if (afterResult.err) {
      return Err(afterResult.err)
    }

    const allCharges = [...beforeResult.val, ...afterResult.val]
    const currency = this.resolveCurrency(params.currency, allCharges, grants)

    const beforePrice = this.aggregateCalculatedPrice(beforeResult.val, currency)
    const afterPrice = this.aggregateCalculatedPrice(afterResult.val, currency)

    let deltaPrice: CalculatedPrice
    try {
      deltaPrice = this.asCalculatedPrice(
        subtract(afterPrice.unitPrice.dinero, beforePrice.unitPrice.dinero),
        subtract(afterPrice.subtotalPrice.dinero, beforePrice.subtotalPrice.dinero),
        subtract(afterPrice.totalPrice.dinero, beforePrice.totalPrice.dinero)
      )
    } catch (error) {
      return Err(
        new UnPriceRatingError({
          message: error instanceof Error ? error.message : "Failed to compute incremental delta",
        })
      )
    }

    return Ok({
      usageBefore,
      usageAfter,
      usageDelta: usageAfter - usageBefore,
      before: beforeResult.val,
      after: afterResult.val,
      deltaPrice,
    })
  }
}
