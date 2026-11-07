import { describe, expect, it } from "vitest"

import { planVersionFeatureInsertBaseSchema } from "./planVersionFeatures"

const billingConfig = {
  name: "monthly",
  billingInterval: "month" as const,
  billingIntervalCount: 1,
  billingAnchor: 1,
  planType: "recurring" as const,
}

describe("planVersionFeatureInsertBaseSchema", () => {
  it("accepts usage features with meterConfig", () => {
    const result = planVersionFeatureInsertBaseSchema.safeParse({
      featureId: "feature_123",
      planVersionId: "plan_version_123",
      featureType: "usage",
      billingConfig,
      order: 1024,
      defaultQuantity: 1,
      meterConfig: {
        eventId: "event_123",
        eventSlug: "llm_completion",
        aggregationMethod: "count",
      },
    })

    expect(result.success).toBe(true)

    if (!result.success) {
      return
    }

    expect(result.data.meterConfig?.aggregationMethod).toBe("count")
  })

  it.each([
    { billingInterval: "year", billingIntervalCount: 1 },
    { billingInterval: "month", billingIntervalCount: 2 },
    { billingInterval: "minute", billingIntervalCount: 1 },
  ] as const)(
    "requires a supported reset for finite usage on $billingInterval × $billingIntervalCount billing",
    (cadence) => {
      const feature = {
        featureId: "feature_123",
        planVersionId: "plan_version_123",
        featureType: "usage",
        billingConfig: { ...billingConfig, ...cadence },
        order: 1024,
        limit: 20,
        config: { usageMode: "unit" },
        meterConfig: { eventId: "event_123", eventSlug: "completion", aggregationMethod: "count" },
      }
      const invalid = planVersionFeatureInsertBaseSchema.safeParse(feature)
      expect(invalid.error?.issues.map((issue) => issue.path)).toContainEqual(["resetConfig"])
      expect(
        planVersionFeatureInsertBaseSchema.safeParse({
          ...feature,
          resetConfig: {
            name: "daily",
            resetInterval: "day",
            resetIntervalCount: 1,
            resetAnchor: 1,
            planType: "recurring",
          },
        }).success
      ).toBe(true)
      expect(
        planVersionFeatureInsertBaseSchema.safeParse({ ...feature, limit: undefined }).success
      ).toBe(true)
    }
  )

  it("rejects non-usage features carrying meterConfig", () => {
    const result = planVersionFeatureInsertBaseSchema.safeParse({
      featureId: "feature_123",
      planVersionId: "plan_version_123",
      featureType: "flat",
      billingConfig,
      order: 1024,
      defaultQuantity: 1,
      meterConfig: {
        eventId: "event_123",
        eventSlug: "llm_completion",
        aggregationMethod: "count",
      },
    })

    expect(result.success).toBe(false)
  })

  it("rejects usage features without meterConfig", () => {
    const result = planVersionFeatureInsertBaseSchema.safeParse({
      featureId: "feature_123",
      planVersionId: "plan_version_123",
      featureType: "usage",
      billingConfig,
      order: 1024,
      defaultQuantity: 1,
    })

    expect(result.success).toBe(false)
  })

  it("rejects a usage feature in package mode without units", () => {
    const feature = {
      featureId: "feature_123",
      planVersionId: "plan_version_123",
      featureType: "usage",
      billingConfig,
      order: 1024,
      defaultQuantity: 1,
      meterConfig: {
        eventId: "event_123",
        eventSlug: "llm_completion",
        aggregationMethod: "count",
      },
    }

    const missing = planVersionFeatureInsertBaseSchema.safeParse({
      ...feature,
      config: { usageMode: "package" },
    })
    const sized = planVersionFeatureInsertBaseSchema.safeParse({
      ...feature,
      config: { usageMode: "package", units: 100 },
    })

    expect(missing.error?.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ["config.units"],
        message: "A usage feature in package mode needs units: how many units one package holds",
      },
    ])
    expect(sized.data?.config).toEqual({ usageMode: "package", units: 100 })
  })

  it("rejects unsupported top-level aggregationMethod", () => {
    const result = planVersionFeatureInsertBaseSchema.safeParse({
      featureId: "feature_123",
      planVersionId: "plan_version_123",
      featureType: "usage",
      billingConfig,
      order: 1024,
      defaultQuantity: 1,
      meterConfig: {
        eventId: "event_123",
        eventSlug: "llm_completion",
        aggregationMethod: "count",
      },
      aggregationMethod: "count",
    })

    expect(result.success).toBe(false)
  })
})
