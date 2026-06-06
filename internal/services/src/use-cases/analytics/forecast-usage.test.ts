import type { FeatureUsagePeriodRow } from "@unprice/analytics"
import { FetchError } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { type ForecastUsageDeps, type ForecastUsageInput, forecastUsage } from "./forecast-usage"

const DAY_MS = 86_400_000
const now = Date.parse("2026-06-06T14:35:12.345Z")
const observationEnd = Date.parse("2026-06-06T00:00:00.000Z")
const observationStart = observationEnd - 14 * DAY_MS

describe("forecastUsage", () => {
  it("projects usage from UTC day buckets without period_key", async () => {
    const usageByDay = Array.from({ length: 14 }, (_, index) => 10 * (index + 1))
    const { deps, analytics } = makeDeps({ usageByDay })

    const result = await forecastUsage(deps, baseInput({ horizonDays: 14 }))

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({
      answer:
        "Projected incremental usage of 140 units for tokens over the next 14 days for customer cus_123. This is a projection, not a prediction.",
      confidence: "high",
      freshness: {
        generatedAt: now,
        dataFrom: observationStart,
        dataTo: observationEnd,
      },
      evidence: Array.from({ length: 13 }, (_, index) => ({
        type: "meter_fact",
        id: `proj_123:cus_123:tokens:${dayKey(observationStart + (index + 1) * DAY_MS)}`,
        source: "tinybird",
        timestamp: observationStart + (index + 2) * DAY_MS,
      })),
      warnings: [
        "This is a projection of incremental horizon usage from day-over-day cumulative usage deltas, not a prediction.",
      ],
      nextActions: ["Compare this projection against entitlement limits and wallet runway."],
      project_id: "proj_123",
      customer_id: "cus_123",
      feature_slug: "tokens",
      horizonDays: 14,
      projectedUsage: 140,
      observedDays: 13,
      baselineUsage: 10,
      trendPerDay: 0,
    })
    expect(analytics.getFeaturesUsagePeriod).toHaveBeenCalledTimes(14)
    expect(analytics.getFeaturesUsagePeriod).toHaveBeenNthCalledWith(1, {
      project_id: "proj_123",
      customer_id: "cus_123",
      feature_slugs: ["tokens"],
      start: observationStart,
      end: observationStart + DAY_MS,
    })
  })

  it("does not sum future cumulative levels as horizon usage", async () => {
    const usageByDay = Array.from<number | null>({ length: 14 }).fill(null)
    usageByDay[11] = 10
    usageByDay[12] = 20
    usageByDay[13] = 30
    const { deps } = makeDeps({ usageByDay })

    const result = await forecastUsage(deps, baseInput({ horizonDays: 3 }))

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual(
      expect.objectContaining({
        projectedUsage: 30,
        observedDays: 2,
        baselineUsage: 10,
        trendPerDay: 0,
      })
    )
  })

  it("uses the default horizon and returns low confidence for zero observed rows", async () => {
    const { deps } = makeDeps({ usageByDay: Array.from<number | null>({ length: 14 }).fill(null) })

    const result = await forecastUsage(deps, baseInput())

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual(
      expect.objectContaining({
        confidence: "low",
        horizonDays: 14,
        projectedUsage: 0,
        observedDays: 0,
        baselineUsage: 0,
        trendPerDay: 0,
        evidence: [],
        warnings: [
          "This is a projection of incremental horizon usage from day-over-day cumulative usage deltas, not a prediction.",
          "Fewer than five observed days were available, so confidence is low.",
        ],
        nextActions: ["Collect at least five days of usage before relying on the projection."],
      })
    )
    expect(result.val?.freshness).toEqual({
      generatedAt: now,
      dataFrom: observationStart,
      dataTo: observationEnd,
    })
  })

  it("includes period_key in Tinybird queries and stable evidence IDs when provided", async () => {
    const usageByDay = Array.from<number | null>({ length: 14 }).fill(null)
    usageByDay[12] = 3
    usageByDay[13] = 7
    const { deps, analytics } = makeDeps({ usageByDay })

    const result = await forecastUsage(
      deps,
      baseInput({
        periodKey: "month:2026-06",
        horizonDays: 1,
      })
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.periodKey).toBe("month:2026-06")
    expect(result.val?.projectedUsage).toBe(4)
    expect(result.val?.evidence).toEqual([
      {
        type: "meter_fact",
        id: "proj_123:cus_123:tokens:month:2026-06:2026-06-05",
        source: "tinybird",
        timestamp: observationEnd,
      },
    ])
    expect(analytics.getFeaturesUsagePeriod).toHaveBeenNthCalledWith(14, {
      project_id: "proj_123",
      customer_id: "cus_123",
      feature_slugs: ["tokens"],
      start: observationEnd - DAY_MS,
      end: observationEnd,
      period_key: "month:2026-06",
    })
  })

  it("maps Tinybird failures to FetchError results", async () => {
    const { deps } = makeDeps({ error: new Error("tinybird unavailable") })

    const result = await forecastUsage(deps, baseInput())

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toBe("tinybird unavailable")
  })
})

function baseInput(overrides: Partial<ForecastUsageInput> = {}): ForecastUsageInput {
  return {
    projectId: "proj_123",
    customerId: "cus_123",
    featureSlug: "tokens",
    ...overrides,
  }
}

function makeDeps({
  usageByDay = [],
  error,
}: {
  usageByDay?: Array<number | null>
  error?: Error
} = {}): { deps: ForecastUsageDeps; analytics: ForecastUsageDeps["analytics"] } {
  const analytics = {
    getFeaturesUsagePeriod: vi.fn(
      async (query: {
        project_id: string
        customer_id?: string
        feature_slugs?: string[]
        start?: number
        end?: number
        period_key?: string
      }) => {
        if (error) {
          throw error
        }

        const dayIndex =
          typeof query.start === "number"
            ? Math.floor((query.start - observationStart) / DAY_MS)
            : -1
        const usage = usageByDay[dayIndex]

        return {
          meta: [],
          data:
            typeof usage === "number"
              ? [
                  {
                    project_id: query.project_id,
                    customer_id: query.customer_id ?? "cus_123",
                    feature_slug: query.feature_slugs?.[0] ?? "tokens",
                    usage,
                  } satisfies FeatureUsagePeriodRow,
                ]
              : [],
        }
      }
    ),
  }

  return {
    deps: {
      analytics,
      now: () => now,
    },
    analytics,
  }
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}
