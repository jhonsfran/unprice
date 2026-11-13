import { describe, expect, it } from "vitest"

import { meterConfigSchema } from "./shared"

describe("meterConfigSchema", () => {
  it("accepts count without aggregationField", () => {
    const result = meterConfigSchema.safeParse({
      eventId: "event_123",
      eventSlug: "llm_completion",
      aggregationMethod: "count",
    })

    expect(result.success).toBe(true)
  })

  it("rejects sum without aggregationField", () => {
    const result = meterConfigSchema.safeParse({
      eventId: "event_123",
      eventSlug: "llm_completion",
      aggregationMethod: "sum",
    })

    expect(result.success).toBe(false)
  })

  it.each(["max", "latest"])(
    "rejects the retired %s aggregation even with a field",
    (aggregationMethod) => {
      expect(
        meterConfigSchema.safeParse({
          eventId: "event_123",
          eventSlug: "llm_completion",
          aggregationMethod,
          aggregationField: "tokens",
        }).success
      ).toBe(false)
    }
  )

  it.each(["filters", "windowSize"])("rejects the unused %s meter field", (field) => {
    expect(
      meterConfigSchema.safeParse({
        eventId: "event_123",
        eventSlug: "llm_completion",
        aggregationMethod: "count",
        [field]: field === "filters" ? { model: "gpt" } : "HOUR",
      }).success
    ).toBe(false)
  })

  it("rejects removed lifetime aggregations", () => {
    for (const aggregationMethod of ["sum", "count", "max"].map((method) => `${method}_all`)) {
      const result = meterConfigSchema.safeParse({
        eventId: "event_123",
        eventSlug: "llm_completion",
        aggregationMethod,
      })

      expect(result.success).toBe(false)
    }
  })
})
