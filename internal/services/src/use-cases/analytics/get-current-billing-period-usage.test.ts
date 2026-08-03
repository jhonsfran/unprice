import type { BillingPeriodUsageCoverageRow, BillingPeriodUsageRow } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { FetchError } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import {
  BillingPeriodUsageCoverageError,
  type GetCurrentBillingPeriodUsageDeps,
  getCurrentBillingPeriodUsage,
} from "./get-current-billing-period-usage"

const now = Date.UTC(2026, 7, 2, 9, 0, 0)

describe("getCurrentBillingPeriodUsage", () => {
  it("joins billing-period usage and bounds Tinybird to the active-period envelope", async () => {
    const { analytics, deps } = makeDeps({
      billingPeriods: [
        billingPeriod({
          id: "bp_usage",
          cycleStartAt: now - 86_400_000,
          cycleEndAt: now + 2_505_600_000,
        }),
        billingPeriod({
          id: "bp_base",
          cycleStartAt: now - 2_592_000_000,
          cycleEndAt: now + 86_400_000,
        }),
      ],
      usageRows: [usageRow({ billing_period_id: "bp_usage" })],
    })

    const result = await getCurrentBillingPeriodUsage(deps, {
      projectId: "proj_123",
      customerId: "cus_123",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({
      billingPeriods: [
        {
          id: "bp_usage",
          cycleStartAt: now - 86_400_000,
          cycleEndAt: now + 2_505_600_000,
          usage: [
            {
              featureSlug: "tokens",
              usage: 5_100,
              amount: 5_100_000,
              currency: "USD",
            },
          ],
        },
        {
          id: "bp_base",
          cycleStartAt: now - 2_592_000_000,
          cycleEndAt: now + 86_400_000,
          usage: [],
        },
      ],
    })
    expect(analytics.getBillingPeriodUsage).toHaveBeenCalledWith({
      project_id: "proj_123",
      customer_id: "cus_123",
      billing_period_ids: ["bp_usage", "bp_base"],
      start: now - 2_592_000_000,
      end: now + 2_505_600_000,
    })
    expect(analytics.getBillingPeriodUsageCoverage).toHaveBeenCalledWith({
      project_id: "proj_123",
      customer_id: "cus_123",
      start: now - 2_592_000_000,
      end: now + 2_505_600_000,
    })
  })

  it("does not query Tinybird when no billing period is active", async () => {
    const { analytics, deps } = makeDeps({ billingPeriods: [] })

    const result = await getCurrentBillingPeriodUsage(deps, {
      projectId: "proj_123",
      customerId: "cus_123",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({ billingPeriods: [] })
    expect(analytics.getBillingPeriodUsage).not.toHaveBeenCalled()
    expect(analytics.getBillingPeriodUsageCoverage).not.toHaveBeenCalled()
  })

  it("returns Tinybird failures as retryable fetch errors", async () => {
    const { deps } = makeDeps({ analyticsError: new Error("tinybird unavailable") })

    const result = await getCurrentBillingPeriodUsage(deps, {
      projectId: "proj_123",
      customerId: "cus_123",
    })

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toBe("tinybird unavailable")
  })

  it("fails closed when active usage includes pre-attribution facts", async () => {
    const { deps } = makeDeps({
      coverageRows: [coverageRow({ unattributed_fact_count: 1 })],
    })

    const result = await getCurrentBillingPeriodUsage(deps, {
      projectId: "proj_123",
      customerId: "cus_123",
    })

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(BillingPeriodUsageCoverageError)
  })

  it("returns coverage Tinybird failures as retryable fetch errors", async () => {
    const { deps } = makeDeps({ coverageError: new Error("coverage unavailable") })

    const result = await getCurrentBillingPeriodUsage(deps, {
      projectId: "proj_123",
      customerId: "cus_123",
    })

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toBe("coverage unavailable")
  })
})

function makeDeps(
  options: {
    analyticsError?: Error
    billingPeriods?: Array<{ id: string; cycleStartAt: number; cycleEndAt: number }>
    coverageError?: Error
    coverageRows?: BillingPeriodUsageCoverageRow[]
    usageRows?: BillingPeriodUsageRow[]
  } = {}
) {
  const findMany = vi.fn().mockResolvedValue(options.billingPeriods ?? [billingPeriod({})])
  const analytics = {
    getBillingPeriodUsage: vi.fn().mockImplementation(async () => {
      if (options.analyticsError) throw options.analyticsError
      return { data: options.usageRows ?? [usageRow({})] }
    }),
    getBillingPeriodUsageCoverage: vi.fn().mockImplementation(async () => {
      if (options.coverageError) throw options.coverageError
      return { data: options.coverageRows ?? [coverageRow({})] }
    }),
  }
  const deps: GetCurrentBillingPeriodUsageDeps = {
    analytics,
    db: {
      query: {
        billingPeriods: { findMany },
      },
    } as unknown as Database,
    now: () => now,
  }

  return { analytics, deps }
}

function billingPeriod(
  overrides: Partial<{ id: string; cycleStartAt: number; cycleEndAt: number }>
) {
  return {
    id: "bp_current",
    cycleStartAt: now - 86_400_000,
    cycleEndAt: now + 2_505_600_000,
    ...overrides,
  }
}

function usageRow(overrides: Partial<BillingPeriodUsageRow>): BillingPeriodUsageRow {
  return {
    project_id: "proj_123",
    customer_id: "cus_123",
    billing_period_id: "bp_current",
    feature_slug: "tokens",
    usage: 5_100,
    amount: 5_100_000,
    currency: "USD",
    ...overrides,
  }
}

function coverageRow(
  overrides: Partial<BillingPeriodUsageCoverageRow>
): BillingPeriodUsageCoverageRow {
  return {
    unattributed_fact_count: 0,
    ...overrides,
  }
}
