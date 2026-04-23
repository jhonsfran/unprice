import { describe, expect, it } from "vitest"
import { LocalReservation, thresholdFromBps } from "./local-reservation"

const DOLLAR = 100_000_000

describe("thresholdFromBps", () => {
  it("computes 20% of $10 (2000 bps) = $2", () => {
    expect(thresholdFromBps(10 * DOLLAR, 2000)).toBe(2 * DOLLAR)
  })

  it("floors sub-unit fractions", () => {
    // 3 minor units * 1 bp / 10000 = 0.0003 → 0
    expect(thresholdFromBps(3, 1)).toBe(0)
  })

  it("returns 0 for non-positive inputs", () => {
    expect(thresholdFromBps(0, 2000)).toBe(0)
    expect(thresholdFromBps(100, 0)).toBe(0)
    expect(thresholdFromBps(-100, 2000)).toBe(0)
  })
})

describe("LocalReservation.applyUsage", () => {
  const threshold = 2 * DOLLAR // $2
  const chunk = 5 * DOLLAR // $5
  const lr = new LocalReservation(threshold, chunk)

  it("allows a cost strictly below remaining, no refill", () => {
    const state = { allocationAmount: 10 * DOLLAR, consumedAmount: 0 }
    const res = lr.applyUsage(state, 1 * DOLLAR)

    expect(res.isAllowed).toBe(true)
    expect(res.newState.consumedAmount).toBe(1 * DOLLAR)
    expect(res.newState.allocationAmount).toBe(10 * DOLLAR)
    expect(res.needsRefill).toBe(false)
    expect(res.refillRequestAmount).toBe(0)
  })

  it("allows an exact-match cost (cost == remaining), flags refill", () => {
    const state = { allocationAmount: 10 * DOLLAR, consumedAmount: 9 * DOLLAR }
    const res = lr.applyUsage(state, 1 * DOLLAR)

    expect(res.isAllowed).toBe(true)
    expect(res.newState.consumedAmount).toBe(10 * DOLLAR)
    // remaining is now 0 < threshold ($2)
    expect(res.needsRefill).toBe(true)
    expect(res.refillRequestAmount).toBe(chunk)
  })

  it("denies when cost exceeds remaining; state unchanged; refill requested", () => {
    const state = { allocationAmount: 5 * DOLLAR, consumedAmount: 4 * DOLLAR }
    const res = lr.applyUsage(state, 2 * DOLLAR)

    expect(res.isAllowed).toBe(false)
    expect(res.newState).toBe(state) // identity preserved
    expect(res.needsRefill).toBe(true)
    expect(res.refillRequestAmount).toBe(chunk)
  })

  it("flips needsRefill exactly at the threshold boundary", () => {
    // allocation 10, consumed 7 -> remaining 3 (> threshold 2): no refill
    let state = { allocationAmount: 10 * DOLLAR, consumedAmount: 7 * DOLLAR }
    let res = lr.applyUsage(state, 1 * DOLLAR) // new remaining = 2
    // 2 < 2? false — still at the boundary, not yet below
    expect(res.needsRefill).toBe(false)

    // one more minor unit pushes it below the threshold
    state = { allocationAmount: 10 * DOLLAR, consumedAmount: 8 * DOLLAR }
    res = lr.applyUsage(state, 1) // new remaining = 2 * DOLLAR - 1
    expect(res.needsRefill).toBe(true)
  })
})

describe("LocalReservation.applyRefill", () => {
  const lr = new LocalReservation(1 * DOLLAR, 5 * DOLLAR)

  it("adds grantedAmount to allocation, leaves consumed untouched", () => {
    const state = { allocationAmount: 10 * DOLLAR, consumedAmount: 9 * DOLLAR }
    const next = lr.applyRefill(state, 5 * DOLLAR)
    expect(next).toEqual({
      allocationAmount: 15 * DOLLAR,
      consumedAmount: 9 * DOLLAR,
    })
  })

  it("no-op on zero grant", () => {
    const state = { allocationAmount: 4, consumedAmount: 1 }
    expect(lr.applyRefill(state, 0)).toEqual(state)
  })
})

describe("LocalReservation.getCaptureMath", () => {
  const lr = new LocalReservation(0, 0)

  it("splits consumed vs refund when unused remainder exists", () => {
    const math = lr.getCaptureMath({
      allocationAmount: 10 * DOLLAR,
      consumedAmount: 3 * DOLLAR,
    })
    expect(math).toEqual({
      totalConsumedAmount: 3 * DOLLAR,
      totalRefundAmount: 7 * DOLLAR,
    })
  })

  it("returns refund=0 when fully consumed", () => {
    const math = lr.getCaptureMath({
      allocationAmount: 10 * DOLLAR,
      consumedAmount: 10 * DOLLAR,
    })
    expect(math).toEqual({
      totalConsumedAmount: 10 * DOLLAR,
      totalRefundAmount: 0,
    })
  })

  it("clamps negative refund to 0 (over-consumed edge case)", () => {
    const math = lr.getCaptureMath({
      allocationAmount: 10 * DOLLAR,
      consumedAmount: 11 * DOLLAR,
    })
    expect(math.totalRefundAmount).toBe(0)
  })
})
