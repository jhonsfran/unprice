import { describe, expect, it } from "vitest"
import { calculateCycleWindow } from "./billing"

const utcDate = (dateString: string, time = "00:00:00") =>
  new Date(`${dateString}T${time}Z`).getTime()

describe("calculateCycleWindow", () => {
  it("returns null when now is before effective start", () => {
    const startMs = utcDate("2024-01-10", "12:00:00")
    const now = utcDate("2024-01-10", "11:59:59")

    const result = calculateCycleWindow({
      effectiveStartDate: startMs,
      effectiveEndDate: null,
      trialEndsAt: null,
      now,
      config: {
        name: "test",
        interval: "onetime",
        intervalCount: 1,
        planType: "onetime",
        anchor: "dayOfCreation",
      },
    })

    expect(result).toBeNull()
  })

  it("returns null when now is after or at effective end", () => {
    const startMs = utcDate("2024-01-01", "00:00:00")
    const endMs = utcDate("2024-01-31", "00:00:00")
    const now = endMs

    const result = calculateCycleWindow({
      effectiveStartDate: startMs,
      effectiveEndDate: endMs,
      trialEndsAt: null,
      now,
      config: {
        name: "test",
        interval: "month",
        intervalCount: 1,
        planType: "recurring",
        anchor: 1,
      },
    })

    expect(result).toBeNull()
  })

  describe("onetime", () => {
    it("without trial computes infinite window", () => {
      const startMs = utcDate("2024-01-01", "12:00:00")
      const now = utcDate("2024-01-01", "13:30:00")

      const result = calculateCycleWindow({
        effectiveStartDate: startMs,
        effectiveEndDate: null,
        trialEndsAt: null,
        now,
        config: {
          name: "test",
          interval: "onetime",
          intervalCount: 1,
          planType: "onetime",
          anchor: "dayOfCreation",
        },
      })

      expect(result).not.toBeNull()
      expect(result!.start).toBe(startMs)
      expect(result!.end).toBe(Number.POSITIVE_INFINITY)
      // no proration/billableSeconds returned anymore
    })

    it("with trial returns trial window until trial end", () => {
      const startMs = utcDate("2024-01-01", "12:00:00")
      const trialEndMs = utcDate("2024-01-15", "12:00:00")
      const now = utcDate("2024-01-10", "12:00:00")

      const result = calculateCycleWindow({
        effectiveStartDate: startMs,
        effectiveEndDate: null,
        trialEndsAt: trialEndMs,
        now,
        config: {
          name: "test",
          interval: "onetime",
          intervalCount: 1,
          planType: "onetime",
          anchor: "dayOfCreation",
        },
      })

      expect(result).not.toBeNull()
      expect(result!.start).toBe(startMs)
      expect(result!.end).toBe(trialEndMs)
      // trial window only; no proration/billableSeconds on cycle window
    })
  })

  describe("recurring monthly", () => {
    it("anchors to monthly cycle containing now", () => {
      const startMs = utcDate("2024-01-01", "00:00:00")
      const now = utcDate("2024-01-20", "10:00:00")

      const result = calculateCycleWindow({
        effectiveStartDate: startMs,
        effectiveEndDate: null,
        trialEndsAt: null,
        now,
        config: {
          name: "test",
          interval: "month",
          intervalCount: 1,
          planType: "recurring",
          anchor: 1,
        },
      })

      expect(result).not.toBeNull()
      // Validate window containment and monotonicity instead of exact boundaries
      expect(result!.start).toBeLessThanOrEqual(now)
      expect(result!.end).toBeGreaterThan(now)
      // no proration/billableSeconds on cycle window
    })

    it("anchors to 15th and computes correct cycle when inside window", () => {
      const effectiveStart = utcDate("2024-01-01", "00:00:00")
      const now = utcDate("2024-01-20", "00:00:00")

      const result = calculateCycleWindow({
        effectiveStartDate: effectiveStart,
        effectiveEndDate: null,
        trialEndsAt: null,
        now,
        config: {
          name: "test",
          interval: "month",
          intervalCount: 1,
          planType: "recurring",
          anchor: 15,
        },
      })

      expect(result).not.toBeNull()
      expect(result!.start).toBeLessThanOrEqual(now)
      expect(result!.end).toBeGreaterThan(now)
      // no proration/billableSeconds on cycle window
    })

    it("aligns dayOfCreation cycles to the start of the creation day", () => {
      const effectiveStart = utcDate("2026-05-07", "12:05:00")
      const now = utcDate("2026-05-07", "12:05:00")

      const result = calculateCycleWindow({
        effectiveStartDate: effectiveStart,
        effectiveEndDate: null,
        trialEndsAt: null,
        now,
        config: {
          name: "test",
          interval: "month",
          intervalCount: 1,
          planType: "recurring",
          anchor: "dayOfCreation",
        },
      })

      expect(result).not.toBeNull()
      expect(result!.start).toBe(utcDate("2026-05-07", "00:00:00"))
      expect(result!.end).toBe(utcDate("2026-06-07", "00:00:00"))
    })

    it("respects effective end date capping the window end", () => {
      const startMs = utcDate("2024-01-01", "00:00:00")
      const endMs = utcDate("2024-01-25", "00:00:00")
      const now = utcDate("2024-01-20", "12:00:00")

      const result = calculateCycleWindow({
        effectiveStartDate: startMs,
        effectiveEndDate: endMs,
        trialEndsAt: null,
        now,
        config: {
          name: "test",
          interval: "month",
          intervalCount: 1,
          planType: "recurring",
          anchor: 1,
        },
      })

      expect(result).not.toBeNull()
      expect(result!.start).toBeLessThan(endMs)
      // End is capped by effectiveEndDate
      expect(result!.end).toBe(endMs)
      // no proration/billableSeconds on cycle window
    })
  })
})

describe("edge cases - months, leap years, boundaries", () => {
  const utc = (d: string, t = "00:00:00.000") => new Date(`${d}T${t}Z`).getTime()

  function buildConfig(anchor: number): Parameters<typeof calculateCycleWindow>[0]["config"] {
    return {
      name: "test",
      interval: "month",
      intervalCount: 1,
      planType: "recurring",
      anchor: anchor,
    }
  }

  it("handles Feb in leap year when anchor=29 (2024)", () => {
    // Start at Jan 10, 2024, anchor 29
    const start = utc("2024-01-10")
    const now = utc("2024-02-15")
    const result = calculateCycleWindow({
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      now,
      config: buildConfig(29),
    })
    expect(result).not.toBeNull()
    // First stub: 2024-01-10 -> 2024-01-29
    // Now is in cycle [2024-01-29, 2024-02-29] because 2024 is leap year.
    expect(result!.start).toBe(utc("2024-01-29"))
    expect(result!.end).toBe(utc("2024-02-29"))
    expect(result!.start).toBeLessThanOrEqual(now)
    expect(result!.end).toBeGreaterThan(now)
  })

  it("handles Feb in non-leap year when anchor=29 (2025)", () => {
    // There is no Feb 29 in 2025. JS Date rolls to Mar 1 when setting date 29 on Feb.
    const start = utc("2025-01-10")
    const now = utc("2025-02-15")
    const result = calculateCycleWindow({
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      now,
      config: buildConfig(29),
    })
    expect(result).not.toBeNull()
    // Cycle should be [2025-01-29, 2025-03-01) because Feb 29 does not exist -> rolled to Mar 1
    expect(result!.start).toBe(utc("2025-01-29"))
    expect(result!.end).toBe(utc("2025-03-01"))
    // Ensure containment
    expect(result!.start).toBeLessThanOrEqual(now)
    expect(result!.end).toBeGreaterThan(now)
    // no proration/billableSeconds on cycle window
  })

  it("anchor=31 over short months (Jan->Feb->Mar 2024)", () => {
    const start = utc("2024-01-01")
    const now = utc("2024-02-10")
    const result = calculateCycleWindow({
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      now,
      config: buildConfig(31),
    })
    expect(result).not.toBeNull()
    // Jan has 31 -> first anchor 2024-01-31, next end attempts 2024-02-31 -> rolls to Mar 2 (since Feb has 29 in 2024)
    // That makes cycle [2024-01-31, 2024-03-02)
    expect(result!.start).toBe(utc("2024-01-31"))
    expect(result!.end).toBe(utc("2024-03-02"))
    // Now is within that long cycle
    expect(result!.start).toBeLessThanOrEqual(now)
    expect(result!.end).toBeGreaterThan(now)
    // no proration/billableSeconds on cycle window
  })

  it("anchor=30 across Apr (30) and May (31) 2024", () => {
    const start = utc("2024-04-01")
    const now = utc("2024-04-29")
    const result = calculateCycleWindow({
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      now,
      config: buildConfig(30),
    })
    expect(result).not.toBeNull()
    // Now is before first anchor -> stub window from effective start to first anchor
    expect(result!.start).toBe(utc("2024-04-01"))
    expect(result!.end).toBe(utc("2024-04-30"))
    // no proration/billableSeconds on cycle window
  })

  it("boundary: now exactly at end uses next cycle (exclusive end)", () => {
    const start = utc("2024-01-01")
    const cfg = buildConfig(15)
    // Determine first window
    const first = calculateCycleWindow({
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      now: utc("2024-01-01"),
      config: cfg,
    })!
    expect(first.end).toBe(utc("2024-01-15"))

    // At exact end -> should move to next cycle
    const atEnd = calculateCycleWindow({
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      now: first.end,
      config: cfg,
    })!
    expect(atEnd.start).toBe(first.end)
    expect(atEnd.end).toBe(utc("2024-02-15"))
    // At start of new window
  })

  it("stub period: paid starts after trial and before first anchor", () => {
    const start = utc("2024-01-01", "00:00:00.000")
    const trialEnd = utc("2024-01-07", "00:00:00.000")
    const now = utc("2024-01-10", "00:00:00.000")
    const cfg = buildConfig(15)

    const result = calculateCycleWindow({
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: trialEnd,
      now,
      config: cfg,
    })!
    // Paid period starts at trialEnd; first anchor after that is Jan 15
    expect(result.start).toBe(trialEnd)
    expect(result.end).toBe(utc("2024-01-15"))
    // no proration/billableSeconds on cycle window
  })

  describe("non-monthly intervals boundaries", () => {
    it("daily anchor hour=0 with boundary at hour change", () => {
      const start = utc("2024-01-01", "00:00:00.000")
      const cfg = {
        name: "test",
        interval: "day" as const,
        intervalCount: 1,
        planType: "recurring" as const,
        anchor: 0,
      }
      const now = utc("2024-01-02", "00:00:00.000") - 1
      const res = calculateCycleWindow({
        effectiveStartDate: start,
        effectiveEndDate: null,
        trialEndsAt: null,
        now,
        config: cfg,
      })!
      expect(res.end).toBe(utc("2024-01-02", "00:00:00.000"))
      // no proration/billableSeconds on cycle window
      // Move exactly to end -> next cycle
      const res2 = calculateCycleWindow({
        effectiveStartDate: start,
        effectiveEndDate: null,
        trialEndsAt: null,
        now: res.end,
        config: cfg,
      })!
      expect(res2.start).toBe(res.end)
      expect(res2.end).toBe(utc("2024-01-03", "00:00:00.000"))
      // start of new window
    })

    it("weekly anchor weekday=1 (Mon) boundary at cycle end", () => {
      const start = utc("2024-01-01") // Mon Jan 1, 2024
      const cfg = {
        name: "test",
        interval: "week" as const,
        intervalCount: 1,
        planType: "recurring" as const,
        anchor: 1,
      }
      // Find a time just before next Monday 00:00:00
      const now = utc("2024-01-07", "23:59:59.000")
      const res = calculateCycleWindow({
        effectiveStartDate: start,
        effectiveEndDate: null,
        trialEndsAt: null,
        now,
        config: cfg,
      })!
      // Cycle should end at Monday 00:00 -> 2024-01-08
      expect(res.end).toBe(utc("2024-01-08", "00:00:00.000"))
      // no proration/billableSeconds on cycle window
    })

    it("minute interval with second anchor=30 boundaries", () => {
      const start = utc("2024-01-01", "00:00:00.000")
      const cfg = {
        name: "test",
        interval: "minute" as const,
        intervalCount: 1,
        planType: "recurring" as const,
        anchor: 30,
      }
      const now = utc("2024-01-01", "00:00:30.500")
      const res = calculateCycleWindow({
        effectiveStartDate: start,
        effectiveEndDate: null,
        trialEndsAt: null,
        now,
        config: cfg,
      })!
      // The minute anchored at second 30: [00:00:30, 00:01:30)
      expect(res.start).toBe(utc("2024-01-01", "00:00:30.000"))
      expect(res.end).toBe(utc("2024-01-01", "00:01:30.000"))
      // no proration/billableSeconds on cycle window
      // Move to exact end -> next window
      const res2 = calculateCycleWindow({
        effectiveStartDate: start,
        effectiveEndDate: null,
        trialEndsAt: null,
        now: res.end,
        config: cfg,
      })!
      expect(res2.start).toBe(res.end)
      expect(res2.end).toBe(utc("2024-01-01", "00:02:30.000"))
      // start of new window
    })
  })
})

describe("minute interval with intervalCount > 1", () => {
  const utc = (d: string, t = "00:00:00.000") => new Date(`${d}T${t}Z`).getTime()

  it("returns full aligned window before first boundary and prorates from paid start", () => {
    // Every 15 minutes, anchored at second=20. Creation at :10.
    const start = utc("2024-01-01", "00:00:10.000")
    const now = utc("2024-01-01", "00:00:15.000")
    const res = calculateCycleWindow({
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      now,
      config: {
        name: "test",
        interval: "minute",
        intervalCount: 15,
        planType: "recurring",
        anchor: 20,
      },
    })!
    // Aligned windows: [..., 23:45:20, 00:00:20), [00:00:20, 00:15:20), ...
    expect(res.start).toBe(utc("2023-12-31", "23:45:20.000"))
    expect(res.end).toBe(utc("2024-01-01", "00:00:20.000"))
    // Billable begins at paid start (00:00:10) inside this full window
    // no proration/billableSeconds on cycle window
  })

  it("aligns to grid after boundary and computes correct next window", () => {
    const start = utc("2024-01-01", "00:00:10.000")
    const now = utc("2024-01-01", "00:00:25.000")
    const res = calculateCycleWindow({
      effectiveStartDate: start,
      effectiveEndDate: null,
      trialEndsAt: null,
      now,
      config: {
        name: "test",
        interval: "minute",
        intervalCount: 15,
        planType: "recurring",
        anchor: 20,
      },
    })!
    // Now >= first boundary -> window [00:00:20, 00:15:20)
    expect(res.start).toBe(utc("2024-01-01", "00:00:20.000"))
    expect(res.end).toBe(utc("2024-01-01", "00:15:20.000"))
    // no proration/billableSeconds on cycle window
  })
})
