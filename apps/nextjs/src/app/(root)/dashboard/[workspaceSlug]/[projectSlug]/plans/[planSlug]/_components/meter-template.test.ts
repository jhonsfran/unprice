import { describe, expect, it } from "vitest"
import {
  measureOf,
  measureOptions,
  meterMatchesTemplate,
  meterSummary,
  withMeasure,
} from "./meter-template"

const countJobs = { eventId: "evt_1", eventSlug: "image_jobs", aggregationMethod: "count" as const }
const sumTokens = {
  eventId: "evt_2",
  eventSlug: "ai_completion",
  aggregationMethod: "sum" as const,
  aggregationField: "input_tokens",
}

describe("meterSummary", () => {
  it("reads as a sentence fragment after 'Measured by'", () => {
    expect(meterSummary(countJobs)).toBe("Count of image_jobs")
    expect(meterSummary({ ...countJobs, groupBy: ["model"] })).toBe(
      "Count of image_jobs · varies by model"
    )
    expect(meterSummary(sumTokens)).toBe("Sum of input_tokens on ai_completion")
    expect(meterSummary({ ...sumTokens, groupBy: ["model", "region"] })).toBe(
      "Sum of input_tokens on ai_completion · varies by model, region"
    )
  })
})

describe("meterMatchesTemplate", () => {
  it("follows the template when event, measure, and dimensions agree", () => {
    const sameSlugElsewhere = { ...countJobs, eventId: "evt_other" }
    expect(meterMatchesTemplate(countJobs, sameSlugElsewhere)).toBe(true)
    expect(meterMatchesTemplate({ ...countJobs, groupBy: [] }, countJobs)).toBe(true)
    expect(
      meterMatchesTemplate(
        { ...sumTokens, groupBy: ["region", "model"] },
        { ...sumTokens, groupBy: ["model", "region"] }
      )
    ).toBe(true)
  })

  it("is custom once any of them differs, and never without both sides", () => {
    expect(meterMatchesTemplate({ ...countJobs, groupBy: ["model"] }, countJobs)).toBe(false)
    expect(meterMatchesTemplate({ ...sumTokens, aggregationMethod: "count" }, sumTokens)).toBe(
      false
    )
    expect(
      meterMatchesTemplate({ ...sumTokens, aggregationField: "output_tokens" }, sumTokens)
    ).toBe(false)
    expect(meterMatchesTemplate({ ...countJobs, eventSlug: "jobs" }, countJobs)).toBe(false)
    expect(meterMatchesTemplate(countJobs, null)).toBe(false)
    expect(meterMatchesTemplate(undefined, countJobs)).toBe(false)
  })
})

describe("measure", () => {
  it("offers Count alone for an event without numbers, then each method per property", () => {
    expect(measureOptions([])).toEqual([{ value: "count", label: "Count of events" }])
    expect(measureOptions(["input_tokens", "output_tokens"]).map((option) => option.label)).toEqual(
      ["Count of events", "Sum of input_tokens", "Sum of output_tokens"]
    )
  })

  it("round-trips a meter through its measure, keeping the event and the dimensions", () => {
    expect(measureOf(countJobs)).toBe("count")
    expect(measureOf(sumTokens)).toBe("sum:input_tokens")
    expect(withMeasure({ ...countJobs, groupBy: ["model"] }, "sum:duration")).toEqual({
      eventId: "evt_1",
      eventSlug: "image_jobs",
      aggregationMethod: "sum",
      aggregationField: "duration",
      groupBy: ["model"],
    })
    expect(withMeasure(sumTokens, "count")).toEqual({
      eventId: "evt_2",
      eventSlug: "ai_completion",
      aggregationMethod: "count",
    })
  })
})
