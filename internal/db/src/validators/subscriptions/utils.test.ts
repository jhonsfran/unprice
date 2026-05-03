import { describe, expect, it } from "vitest"
import {
  calculateDateAt,
  calculateProration,
  getAnchor,
  getBillingCycleMessage,
  getTrialIntervalForBillingInterval,
  getTrialUnitLabel,
} from "./utils"
import type { Config } from "./utils"

const utcDate = (date: string, time = "00:00:00.000") => new Date(`${date}T${time}Z`).getTime()

describe("calculateDateAt", () => {
  it("returns start date when no date is configured", () => {
    const start = utcDate("2024-01-01", "12:00:00.000")
    const end = calculateDateAt({ startDate: start, config: null })
    expect(end).toBe(start)
  })

  it("adds duration in days", () => {
    const start = utcDate("2024-01-01", "12:00:00.000")
    const end = calculateDateAt({
      startDate: start,
      config: { interval: "day", units: 7 } as unknown as Config,
    })
    expect(end).toBe(utcDate("2024-01-08", "12:00:00.000"))
  })

  it("adds duration in minutes", () => {
    const start = utcDate("2024-01-01", "12:00:00.000")
    const end = calculateDateAt({
      startDate: start,
      config: { interval: "minute", units: 5 } as unknown as Config,
    })
    expect(end).toBe(utcDate("2024-01-01", "12:05:00.000"))
  })

  it("adds duration in weeks", () => {
    const start = utcDate("2024-01-01", "12:00:00.000")
    const end = calculateDateAt({
      startDate: start,
      config: { interval: "week", units: 2 } as unknown as Config,
    })

    expect(end).toBe(utcDate("2024-01-15", "12:00:00.000"))
  })

  it("adds duration in months", () => {
    const start = utcDate("2024-01-01", "12:00:00.000")
    const end = calculateDateAt({
      startDate: start,
      config: { interval: "month", units: 2 } as unknown as Config,
    })

    expect(end).toBe(utcDate("2024-03-01", "12:00:00.000"))
  })

  it("adds duration in years", () => {
    const start = utcDate("2024-01-01", "12:00:00.000")
    const end = calculateDateAt({
      startDate: start,
      config: { interval: "year", units: 2 } as unknown as Config,
    })

    expect(end).toBe(utcDate("2026-01-01", "12:00:00.000"))
  })
})

describe("getTrialIntervalForBillingInterval", () => {
  it("uses minutes for minute-billed plans", () => {
    expect(getTrialIntervalForBillingInterval("minute")).toBe("minute")
    expect(getTrialUnitLabel({ billingInterval: "minute", units: 5 })).toBe("minutes")
  })

  it("uses days for non-minute billing periods", () => {
    expect(getTrialIntervalForBillingInterval("day")).toBe("day")
    expect(getTrialIntervalForBillingInterval("week")).toBe("day")
    expect(getTrialIntervalForBillingInterval("month")).toBe("day")
    expect(getTrialIntervalForBillingInterval("year")).toBe("day")
    expect(getTrialIntervalForBillingInterval("onetime")).toBe("day")
    expect(getTrialUnitLabel({ billingInterval: "month", units: 1 })).toBe("day")
  })
})

describe("getBillingCycleMessage", () => {
  it("returns onetime message", () => {
    const msg = getBillingCycleMessage({
      name: "test",
      billingInterval: "onetime",
      billingIntervalCount: 1,
      billingAnchor: "dayOfCreation",
      planType: "onetime",
    })
    expect(msg.message).toBe("billed once")
  })

  it("returns monthly generic message when no anchor", () => {
    const msg = getBillingCycleMessage({
      name: "test",
      billingInterval: "month",
      billingIntervalCount: 1,
      billingAnchor: "dayOfCreation",
      planType: "recurring",
    })
    expect(msg.message).toBe("billed once every month")
  })

  it("returns anchored monthly message", () => {
    const msg = getBillingCycleMessage({
      name: "test",
      billingInterval: "month",
      billingIntervalCount: 1,
      billingAnchor: 15,
      planType: "recurring",
    })
    expect(msg.message).toBe("billed monthly on the 15th of the month")
  })

  it("returns anchored yearly message", () => {
    const msg = getBillingCycleMessage({
      name: "test",
      billingInterval: "year",
      billingIntervalCount: 1,
      billingAnchor: 3,
      planType: "recurring",
    })
    expect(msg.message).toBe("billed yearly on the 1st of March")
  })
})

// replaced old now-based proration tests with cycle-aware proration tests below

describe("getAnchor", () => {
  const utc = (d: string, t = "00:00:00.000") => new Date(`${d}T${t}Z`).getTime()

  it("dayOfCreation for month/year returns day of month (UTC)", () => {
    const date = utc("2024-01-31")
    expect(getAnchor(date, "month", "dayOfCreation")).toBe(31)
    expect(getAnchor(date, "year", "dayOfCreation")).toBe(31)
  })

  it("validates minute/day/week numeric anchors and returns as-is", () => {
    const date = utc("2024-01-01")
    expect(getAnchor(date, "minute", 30)).toBe(30)
    expect(() => getAnchor(date, "minute", 60)).toThrow()
    expect(getAnchor(date, "day", 23)).toBe(23)
    expect(() => getAnchor(date, "day", 24)).toThrow()
    expect(getAnchor(date, "week", 6)).toBe(6)
    expect(() => getAnchor(date, "week", 7)).toThrow()
  })

  it("caps monthly anchor to the last day of the target month", () => {
    const jan31 = utc("2024-01-31")
    // February 2024 has 29 days
    expect(getAnchor(jan31, "month", 31)).toBe(31) // for ref month cap is done in window alignment
    // when aligning, the month end cap is applied (tested in billing tests)
    const apr30 = utc("2024-04-30")
    expect(getAnchor(apr30, "month", 31)).toBe(30)
  })
})

describe("calculateProration", () => {
  const utc = (d: string, t = "00:00:00.000") => new Date(`${d}T${t}Z`).getTime()

  it("returns 1 for a full monthly anchored cycle", () => {
    const effectiveStart = utc("2024-01-10")
    const serviceStart = utc("2024-01-15")
    const serviceEnd = utc("2024-02-15")
    const { prorationFactor } = calculateProration({
      serviceStart,
      serviceEnd,
      effectiveStartDate: effectiveStart,
      billingConfig: {
        name: "m",
        billingInterval: "month",
        billingIntervalCount: 1,
        billingAnchor: 15,
        planType: "recurring",
      },
    })
    expect(prorationFactor).toBeCloseTo(1)
  })

  it("computes stub fraction before first monthly anchor", () => {
    const effectiveStart = utc("2024-01-10")
    const serviceStart = utc("2024-01-10")
    const serviceEnd = utc("2024-01-15")
    // Reference full cycle is [Jan 15, Feb 15) so denominator is 31 days
    const { prorationFactor } = calculateProration({
      serviceStart,
      serviceEnd,
      effectiveStartDate: effectiveStart,
      billingConfig: {
        name: "m",
        billingInterval: "month",
        billingIntervalCount: 1,
        billingAnchor: 15,
        planType: "recurring",
      },
    })
    // 5 days / 31 days ≈ 0.16129
    expect(prorationFactor).toBeCloseTo(5 / 31, 5)
  })

  it("aligns to 5-minute cycles and prorates a partial window", () => {
    const day = "2024-01-01"
    const effectiveStart = utc(day, "10:02:30.000")
    const serviceStart = utc(day, "10:05:00.000")
    const serviceEnd = utc(day, "10:07:30.000") // 150 seconds within a 300s cycle
    const { prorationFactor } = calculateProration({
      serviceStart,
      serviceEnd,
      effectiveStartDate: effectiveStart,
      billingConfig: {
        name: "5m",
        billingInterval: "minute",
        billingIntervalCount: 5,
        billingAnchor: 0,
        planType: "recurring",
      },
    })
    expect(prorationFactor).toBeCloseTo(0.5, 5)
  })
})
