import type {
  EntitlementState,
  ReportUsageRequest,
  ReportUsageResult,
  SubscriptionStatus,
  VerificationResult,
  VerifyRequest,
} from "@unprice/db/validators"
import type { CurrentUsage } from "@unprice/db/validators"
import { type BaseError, Ok, type Result } from "@unprice/error"
import type { CacheNamespaces } from "@unprice/services/cache"
import type {
  BufferMetricsResponse,
  GetEntitlementsRequest,
  GetUsageRequest,
  UsageLimiter,
} from "./interface"

export class NoopUsageLimiter implements UsageLimiter {
  public async resetEntitlements(_params: {
    customerId: string
    projectId: string
  }): Promise<Result<void, BaseError>> {
    return Ok(undefined)
  }

  public async resetUsage(_params: {
    customerId: string
    projectId: string
  }): Promise<Result<void, BaseError>> {
    return Ok(undefined)
  }

  public async getAccessControlList(_data: {
    customerId: string
    projectId: string
    now: number
  }): Promise<{
    customerUsageLimitReached: boolean | null
    customerDisabled: boolean | null
    subscriptionStatus: SubscriptionStatus | null
  } | null> {
    return {
      customerUsageLimitReached: false,
      customerDisabled: false,
      subscriptionStatus: "active",
    }
  }

  public async verify(_req: VerifyRequest): Promise<Result<VerificationResult, BaseError>> {
    return Ok({ allowed: true, message: "Allowed" })
  }

  public async reportUsage(
    _req: ReportUsageRequest
  ): Promise<Result<ReportUsageResult, BaseError>> {
    return Ok({ allowed: true, message: "Allowed" })
  }

  public async prewarm(_params: {
    customerId: string
    projectId: string
    now: number
  }): Promise<void> {
    return
  }

  public async getActiveEntitlements(
    _req: GetEntitlementsRequest
  ): Promise<Result<EntitlementState[], BaseError>> {
    return Ok([])
  }

  public async updateAccessControlList(_data: {
    customerId: string
    projectId: string
    updates: Partial<NonNullable<CacheNamespaces["accessControlList"]>>
  }): Promise<void> {
    return
  }

  public async getCurrentUsage(_req: GetUsageRequest): Promise<Result<CurrentUsage, BaseError>> {
    return Ok({
      planName: "No Plan",
      basePrice: 0,
      billingPeriod: "monthly",
      billingPeriodLabel: "mo",
      currency: "USD",
      groups: [],
      priceSummary: {
        totalPrice: 0,
        basePrice: 0,
        usageCharges: 0,
        hasUsageCharges: false,
        flatTotal: 0,
        tieredTotal: 0,
        usageTotal: 0,
        freeGrantsSavings: 0,
        hasFreeGrantsSavings: false,
      },
      renewalDate: undefined,
      daysRemaining: undefined,
    } as unknown as CurrentUsage)
  }

  public async getBufferMetrics(_data: {
    customerId: string
    projectId: string
    windowSeconds?: 300 | 3600 | 86400 | 604800
  }): Promise<Result<BufferMetricsResponse, BaseError>> {
    const windowSeconds = _data.windowSeconds ?? 300
    const bucketSizeSeconds =
      windowSeconds <= 300
        ? 60
        : windowSeconds <= 3600
          ? 300
          : windowSeconds <= 86400
            ? 3600
            : 86400

    return Ok({
      usageCount: 0,
      verificationCount: 0,
      totalUsage: 0,
      allowedCount: 0,
      deniedCount: 0,
      limitExceededCount: 0,
      bucketSizeSeconds,
      featureStats: [],
      usageSeries: [],
      verificationSeries: [],
      oldestTimestamp: null,
      newestTimestamp: null,
    })
  }
}
