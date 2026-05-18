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
