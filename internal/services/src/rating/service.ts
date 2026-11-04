import {
  calculateCycleWindow,
  calculateFreeUnits,
  calculateProration,
  calculateWaterfallPrice,
  type configFeatureSchema,
  getAnchor,
  type grantSchemaExtended,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { z } from "zod"
import type { GrantsManager } from "../entitlements"
import { toErrorContext } from "../utils/log-context"
import { UnPriceRatingError } from "./errors"
import type {
  BillingWindow,
  RatedCharge,
  RatingEntitlementContext,
  RatingInput,
  ResolveBillingWindowInput,
} from "./types"

export class RatingService {
  private readonly logger: Logger
  private readonly grantsManager: GrantsManager

  constructor({
    logger,
    grantsManager,
  }: {
    logger: Logger
    grantsManager: GrantsManager
  }) {
    this.logger = logger
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
    resetConfig: RatingEntitlementContext["resetConfig"]
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
  ): RatingEntitlementContext {
    const customerEntitlement = grant.customerEntitlement
    const featurePlanVersion = customerEntitlement.featurePlanVersion
    const resetConfig = featurePlanVersion.resetConfig

    return {
      effectiveAt: customerEntitlement.effectiveAt,
      expiresAt: customerEntitlement.expiresAt,
      resetConfig: resetConfig
        ? {
            ...resetConfig,
            resetAnchor: getAnchor(
              customerEntitlement.effectiveAt,
              resetConfig.resetInterval,
              resetConfig.resetAnchor
            ),
          }
        : null,
      meterConfig:
        featurePlanVersion.featureType === "usage"
          ? (featurePlanVersion.meterConfig ?? null)
          : null,
      featureType: featurePlanVersion.featureType,
    }
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
      customerEntitlementIds,
      featureSlug,
      grants: providedGrants,
      entitlement: providedEntitlement,
      usageData,
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

    let grants = providedGrants
    if (grants === undefined) {
      const grantsResult = await this.grantsManager.listGrantsForCustomerFeature({
        projectId,
        customerId,
        ...(customerEntitlementIds !== undefined ? { customerEntitlementIds } : {}),
        featureSlug,
        ...(now !== undefined ? { now } : { startAt: startAt!, endAt: endAt! }),
      })

      if (grantsResult.err) {
        return Err(new UnPriceRatingError({ message: grantsResult.err.message }))
      }

      grants = grantsResult.val
    } else if (customerEntitlementIds !== undefined) {
      const entitlementIds = new Set(customerEntitlementIds)
      grants = grants.filter((grant) => entitlementIds.has(grant.customerEntitlement.id))
    }

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
    const usage = usageData.find((item) => item.featureSlug === featureSlug)?.usage ?? 0

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
}
