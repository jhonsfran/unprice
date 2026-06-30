import type {
  FeatureUsagePeriodRow,
  FeatureUsageTimeseriesRow,
  TopConsumerRow,
} from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { FetchError } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import {
  type GetUsageDashboardDeps,
  type GetUsageDashboardInput,
  getUsageDashboard,
} from "./get-usage-dashboard"

const firstHour = Date.parse("2026-06-13T07:00:00.000Z")
const secondHour = Date.parse("2026-06-13T08:00:00.000Z")
const thirdHour = Date.parse("2026-06-13T09:00:00.000Z")
const now = Date.parse("2026-06-13T09:30:00.000Z")

describe("getUsageDashboard", () => {
  it("derives summary rows from period totals and chart rows from time buckets", async () => {
    const { deps, analytics } = makeDeps({
      now: () => now,
      timeseriesRows: [
        timeseriesRow({
          date: firstHour,
          feature_slug: "events",
          usage: 4,
          amount_after: 0,
          currency: "USD",
        }),
        timeseriesRow({
          date: firstHour,
          feature_slug: "customers",
          usage: 3,
          amount_after: 100_000_000,
          currency: "USD",
        }),
        timeseriesRow({
          date: secondHour,
          feature_slug: "events",
          usage: 9,
          amount_after: 0,
          currency: "USD",
        }),
        timeseriesRow({
          date: thirdHour,
          feature_slug: "pages",
          usage: 2,
          amount_after: 0,
          currency: "USD",
        }),
      ],
      periodRows: [
        periodRow({
          feature_slug: "events",
          usage: 13,
          amount_after: 0,
          currency: "USD",
        }),
        periodRow({
          feature_slug: "customers",
          usage: 3,
          amount_after: 100_000_000,
          currency: "USD",
        }),
        periodRow({
          feature_slug: "pages",
          usage: 2,
          amount_after: 0,
          currency: "USD",
        }),
      ],
    })

    const result = await getUsageDashboard(deps, baseInput({ customerId: "cus_1" }))

    expect(result.err).toBeUndefined()
    expect(result.val?.summary).toEqual({
      featureCount: 3,
      totalLatestUsage: 18,
      spending: [
        {
          currency: "USD",
          amount: "1",
          displayAmount: "$1.00",
        },
      ],
    })
    expect(result.val?.features.map((feature) => [feature.featureSlug, feature.usage])).toEqual([
      ["events", 13],
      ["customers", 3],
      ["pages", 2],
    ])
    expect(result.val?.timeseries.map((row) => [row.date, row.featureSlug, row.usage])).toEqual([
      [firstHour, "customers", 3],
      [firstHour, "events", 4],
      [firstHour, "pages", 0],
      [secondHour, "customers", 3],
      [secondHour, "events", 9],
      [secondHour, "pages", 0],
      [thirdHour, "customers", 3],
      [thirdHour, "events", 9],
      [thirdHour, "pages", 2],
    ])
    expect(analytics.getFeaturesUsageTimeseries).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      start: expect.any(Number),
      end: expect.any(Number),
    })
    expect(analytics.getFeaturesUsagePeriod).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      start: expect.any(Number),
      end: expect.any(Number),
    })
    expect(analytics.getTopConsumers).not.toHaveBeenCalled()
  })

  it("loads top consumers only for the project dashboard", async () => {
    const { deps, analytics } = makeDeps({
      now: () => now,
      timeseriesRows: [
        timeseriesRow({
          date: firstHour,
          feature_slug: "events",
          usage: 4,
          amount_after: 0,
          currency: "USD",
        }),
      ],
      periodRows: [
        periodRow({
          feature_slug: "events",
          usage: 4,
          amount_after: 0,
          currency: "USD",
        }),
      ],
      topConsumerRows: [
        {
          customer_id: "cus_1",
          total_usage: 7,
          total_amount_after: 250_000_000,
          currency: "USD",
        },
      ],
      customerRows: [{ id: "cus_1", email: "one@example.com", name: "One" }],
    })

    const result = await getUsageDashboard(deps, baseInput({ customerId: undefined }))

    expect(result.err).toBeUndefined()
    expect(result.val?.topConsumers).toEqual([
      {
        customerId: "cus_1",
        email: "one@example.com",
        name: "One",
        totalUsage: 7,
        displaySpending: "$2.50",
      },
    ])
    expect(analytics.getTopConsumers).toHaveBeenCalledWith({
      project_id: "proj_1",
      start: expect.any(Number),
      end: expect.any(Number),
      limit: 10,
    })
  })

  it("returns fetch errors when the usage time series query fails", async () => {
    const { deps } = makeDeps({
      timeseriesError: new Error("tinybird unavailable"),
      periodRows: [periodRow({})],
    })

    const result = await getUsageDashboard(deps, baseInput({ customerId: "cus_1" }))

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toBe("tinybird unavailable")
  })

  it("returns fetch errors when the usage period query fails", async () => {
    const { deps } = makeDeps({
      timeseriesRows: [timeseriesRow({})],
      periodError: new Error("tinybird period unavailable"),
    })

    const result = await getUsageDashboard(deps, baseInput({ customerId: "cus_1" }))

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toBe("tinybird period unavailable")
  })

  it("returns fetch error when the top-consumers query fails", async () => {
    const { deps } = makeDeps({
      timeseriesRows: [timeseriesRow({})],
      periodRows: [periodRow({})],
      topConsumersError: new Error("tinybird consumers unavailable"),
    })
    const result = await getUsageDashboard(deps, baseInput({ customerId: undefined }))
    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toBe("tinybird consumers unavailable")
  })
})

function baseInput(overrides: Partial<GetUsageDashboardInput> = {}): GetUsageDashboardInput {
  return {
    projectId: "proj_1",
    customerId: "cus_1",
    range: "24h",
    topConsumersLimit: 10,
    ...overrides,
  }
}

function periodRow(overrides: Partial<FeatureUsagePeriodRow>): FeatureUsagePeriodRow {
  return {
    project_id: "proj_1",
    customer_id: "cus_1",
    feature_slug: "events",
    usage: 1,
    amount_after: 0,
    currency: "USD",
    ...overrides,
  }
}

function timeseriesRow(overrides: Partial<FeatureUsageTimeseriesRow>): FeatureUsageTimeseriesRow {
  return {
    date: firstHour,
    feature_slug: "events",
    usage: 1,
    amount_after: 0,
    currency: "USD",
    ...overrides,
  }
}

function makeDeps({
  timeseriesRows = [],
  periodRows = [],
  topConsumerRows = [],
  customerRows = [],
  timeseriesError,
  periodError,
  topConsumersError,
  now: nowFn = () => now,
}: {
  timeseriesRows?: FeatureUsageTimeseriesRow[]
  periodRows?: FeatureUsagePeriodRow[]
  topConsumerRows?: TopConsumerRow[]
  customerRows?: Array<{ id: string; email: string; name: string }>
  timeseriesError?: Error
  periodError?: Error
  topConsumersError?: Error
  now?: () => number
} = {}) {
  const analytics = {
    getFeaturesUsageTimeseries: vi.fn(async () => {
      if (timeseriesError) {
        throw timeseriesError
      }

      return { data: timeseriesRows }
    }),
    getFeaturesUsagePeriod: vi.fn(async () => {
      if (periodError) {
        throw periodError
      }

      return { data: periodRows }
    }),
    getTopConsumers: vi.fn(async () => {
      if (topConsumersError) {
        throw topConsumersError
      }

      return { data: topConsumerRows }
    }),
  }

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => customerRows),
      })),
    })),
  } as unknown as Database

  const deps: GetUsageDashboardDeps = {
    analytics,
    db,
    now: nowFn,
  }

  return { deps, analytics, db }
}
