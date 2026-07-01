import { describe, expect, it } from "vitest"
import type { BillingConfig } from "../shared"
import { calculateCycleWindow, calculateNextNCycles } from "./billing"

const utcDate = (date: string, time = "00:00:00.000") => new Date(`${date}T${time}Z`).getTime()

describe("cycles using calculateCycleWindow", () => {
  it("monthly windows are contiguous across cycles for anchor 15", () => {
    const startAt = utcDate("2024-01-10", "00:00:00.000")

    const billingConfig = {
      name: "test",
      billingInterval: "month",
      billingIntervalCount: 1,
      billingAnchor: 15,
      planType: "recurring",
    } as BillingConfig

    // first window: startAt -> first anchor-bound end
    const first = calculateCycleWindow({
      effectiveStartDate: startAt,
      effectiveEndDate: null,
      trialEndsAt: null,
      now: startAt,
      config: {
        name: billingConfig.name,
        interval: billingConfig.billingInterval,
        intervalCount: billingConfig.billingIntervalCount,
        anchor: billingConfig.billingAnchor,
        planType: billingConfig.planType,
      },
    })
    expect(first).not.toBeNull()
    expect(first!.start).toBe(startAt)
    expect(first!.end).toBe(utcDate("2024-01-15", "00:00:00.000"))

    // next window should start at previous end when now advances into next cycle
    const second = calculateCycleWindow({
      effectiveStartDate: startAt,
      effectiveEndDate: null,
      trialEndsAt: null,
      now: first!.end,
      config: {
        name: billingConfig.name,
        interval: billingConfig.billingInterval,
        intervalCount: billingConfig.billingIntervalCount,
        anchor: billingConfig.billingAnchor,
        planType: billingConfig.planType,
      },
    })

    expect(second).not.toBeNull()
    expect(second!.start).toBe(first!.end)
    expect(second!.end).toBe(utcDate("2024-02-15", "00:00:00.000"))
  })

  it("trial-only window when endAt caps before paid period", () => {
    const startAt = utcDate("2024-01-01", "00:00:00.000")
    const trialEndsAt = utcDate("2024-01-10", "00:00:00.000")
    const endAt = utcDate("2024-01-07", "00:00:00.000")

    const result = calculateCycleWindow({
      effectiveStartDate: startAt,
      effectiveEndDate: endAt,
      trialEndsAt,
      now: utcDate("2024-01-05", "00:00:00.000"),
      config: {
        name: "test",
        interval: "month",
        intervalCount: 1,
        anchor: 15,
        planType: "recurring",
      },
    })

    expect(result).not.toBeNull()
    expect(result!.start).toBe(startAt)
    expect(result!.end).toBe(endAt)
  })
})

describe("calculateCycleWindow (utility coverage)", () => {
  it("respects window", () => {
    const start = utcDate("2024-01-01", "12:00:00.000")
    const trialEnd = utcDate("2024-01-10", "12:00:00.000")
    const now = utcDate("2024-01-05", "12:00:00.000")

    const result = calculateCycleWindow({
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: trialEnd,
      now,
      config: {
        name: "test",
        interval: "month",
        intervalCount: 1,
        anchor: 1,
        planType: "recurring",
      },
    })

    expect(result).not.toBeNull()
    expect(result!.start).toBe(start)
    expect(result!.end).toBe(trialEnd)
  })
})

describe("calculateNextNCycles sequences", () => {
  const utc = (d: string, t = "00:00:00.000") => new Date(`${d}T${t}Z`).getTime()

  function monthlyCfg(anchor: number) {
    return {
      name: "test",
      interval: "month" as const,
      intervalCount: 1,
      anchor: anchor,
      planType: "recurring" as const,
    }
  }

  it("includes all windows from effective start through reference, then appends count", () => {
    const start = utc("2024-01-10")
    const reference = utc("2024-02-20")
    const cfg = monthlyCfg(15)

    const windows = calculateNextNCycles({
      referenceDate: reference,
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      config: cfg,
      count: 2,
    })

    const expected = [
      [utc("2024-01-10"), utc("2024-01-15")],
      [utc("2024-01-15"), utc("2024-02-15")],
      [utc("2024-02-15"), utc("2024-03-15")],
      [utc("2024-03-15"), utc("2024-04-15")],
      [utc("2024-04-15"), utc("2024-05-15")],
    ]

    expect(windows.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      const w = windows[i]!
      expect(w.start).toBe(expected[i]![0])
      expect(w.end).toBe(expected[i]![1])
    }
  })

  it("does not start day-based windows before a sub-day effective start", () => {
    const start = utc("2026-07-01", "14:38:19.929")
    const reference = utc("2026-07-01", "14:45:00.000")
    const cfg = monthlyCfg(1)

    const windows = calculateNextNCycles({
      referenceDate: reference,
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      config: cfg,
      count: 0,
    })

    expect(windows[0]).toEqual({
      start,
      end: utc("2026-08-01"),
    })
  })

  it("reference at exact boundary uses next window; count=0 stops at containing window", () => {
    const start = utc("2024-01-01")
    const cfg = monthlyCfg(15)
    const reference = utc("2024-01-15")

    const windows = calculateNextNCycles({
      referenceDate: reference,
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      config: cfg,
      count: 0,
    })

    const expected = [
      [utc("2024-01-01"), utc("2024-01-15")],
      [utc("2024-01-15"), utc("2024-02-15")],
    ]

    expect(windows.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      const w = windows[i]!
      expect(w.start).toBe(expected[i]![0])
      expect(w.end).toBe(expected[i]![1])
    }
  })

  it("returns empty when reference is before effective start", () => {
    const start = utc("2024-01-10")
    const reference = utc("2024-01-09")
    const cfg = monthlyCfg(15)

    const windows = calculateNextNCycles({
      referenceDate: reference,
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      config: cfg,
      count: 3,
    })

    expect(windows).toEqual([])
  })

  it("caps by effectiveEndDate and does not exceed it even with extra count", () => {
    const start = utc("2024-01-10")
    const cfg = monthlyCfg(15)
    const reference = utc("2024-02-10")
    const endAt = utc("2024-03-01")

    const windows = calculateNextNCycles({
      referenceDate: reference,
      effectiveStartDate: start,
      effectiveEndDate: endAt,
      trialEndsAt: null,
      config: cfg,
      count: 5,
    })

    // Expected:
    // [2024-01-10, 2024-01-15)
    // [2024-01-15, 2024-02-15)
    // [2024-02-15, 2024-03-01) // capped by effectiveEndDate
    const expected = [
      [utc("2024-01-10"), utc("2024-01-15")],
      [utc("2024-01-15"), utc("2024-02-15")],
      [utc("2024-02-15"), endAt],
    ]

    expect(windows.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      const w = windows[i]!
      expect(w.start).toBe(expected[i]![0])
      expect(w.end).toBe(expected[i]![1])
    }
  })

  it("includes trial window then paid windows up to reference plus count", () => {
    const start = utc("2024-01-01")
    const trialEnd = utc("2024-01-07")
    const cfg = monthlyCfg(15)
    const reference = utc("2024-01-10")

    const windows = calculateNextNCycles({
      referenceDate: reference,
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: trialEnd,
      config: cfg,
      count: 1,
    })

    const expected = [
      [utc("2024-01-01"), utc("2024-01-07")], // trial
      [utc("2024-01-07"), utc("2024-01-15")], // stub paid until first anchor
      [utc("2024-01-15"), utc("2024-02-15")], // +1 future cycle
    ]

    expect(windows.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      const w = windows[i]!
      expect(w.start).toBe(expected[i]![0])
      expect(w.end).toBe(expected[i]![1])
    }
  })
})

describe("calculateNextNCycles sequences (minute interval, 5-minute windows)", () => {
  function cfg5m(anchor: number) {
    return {
      name: "test",
      interval: "minute" as const,
      intervalCount: 5,
      anchor: anchor,
      planType: "recurring" as const,
    }
  }

  it("aligns to 5-minute windows and appends count beyond the reference", () => {
    const day = "2024-01-01"
    const start = utcDate(day, "10:02:30.000")
    const reference = utcDate(day, "10:07:00.000")

    const windows = calculateNextNCycles({
      referenceDate: reference,
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      config: cfg5m(0),
      count: 2,
    })

    const expected = [
      [utcDate(day, "10:00:00.000"), utcDate(day, "10:05:00.000")],
      [utcDate(day, "10:05:00.000"), utcDate(day, "10:10:00.000")],
      [utcDate(day, "10:10:00.000"), utcDate(day, "10:15:00.000")],
      [utcDate(day, "10:15:00.000"), utcDate(day, "10:20:00.000")],
    ]

    expect(windows.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      const w = windows[i]!
      expect(w.start).toBe(expected[i]![0])
      expect(w.end).toBe(expected[i]![1])
    }
  })

  it("reference at exact boundary uses next window; count=0", () => {
    const day = "2024-01-01"
    const start = utcDate(day, "10:00:00.000")
    const reference = utcDate(day, "10:05:00.000")

    const windows = calculateNextNCycles({
      referenceDate: reference,
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      config: cfg5m(0),
      count: 0,
    })

    const expected = [
      [utcDate(day, "10:00:00.000"), utcDate(day, "10:05:00.000")],
      [utcDate(day, "10:05:00.000"), utcDate(day, "10:10:00.000")],
    ]

    expect(windows.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      const w = windows[i]!
      expect(w.start).toBe(expected[i]![0])
      expect(w.end).toBe(expected[i]![1])
    }
  })

  it("caps by effectiveEndDate even when appending count", () => {
    const day = "2024-01-01"
    const start = utcDate(day, "10:02:30.000")
    const reference = utcDate(day, "10:06:00.000")
    const endAt = utcDate(day, "10:12:00.000")

    const windows = calculateNextNCycles({
      referenceDate: reference,
      effectiveStartDate: start,
      effectiveEndDate: endAt,
      trialEndsAt: null,
      config: cfg5m(0),
      count: 5,
    })

    const expected = [
      [utcDate(day, "10:00:00.000"), utcDate(day, "10:05:00.000")],
      [utcDate(day, "10:05:00.000"), utcDate(day, "10:10:00.000")],
      [utcDate(day, "10:10:00.000"), endAt],
    ]

    expect(windows.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      const w = windows[i]!
      expect(w.start).toBe(expected[i]![0])
      expect(w.end).toBe(expected[i]![1])
    }
  })

  it("honors second-level anchor inside each 5-minute window", () => {
    const day = "2024-01-01"
    const start = utcDate(day, "10:02:45.000")
    const reference = utcDate(day, "10:07:00.000")

    const windows = calculateNextNCycles({
      referenceDate: reference,
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      config: cfg5m(30),
      count: 1,
    })

    const expected = [
      [utcDate(day, "10:00:30.000"), utcDate(day, "10:05:30.000")],
      [utcDate(day, "10:05:30.000"), utcDate(day, "10:10:30.000")],
      [utcDate(day, "10:10:30.000"), utcDate(day, "10:15:30.000")],
    ]

    expect(windows.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      const w = windows[i]!
      expect(w.start).toBe(expected[i]![0])
      expect(w.end).toBe(expected[i]![1])
    }
  })
})
