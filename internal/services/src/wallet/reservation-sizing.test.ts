import { describe, expect, it } from "vitest"
import {
  DEFAULT_RESERVATION_POLICY,
  type ReservationPolicy,
  computeEffectiveWalletCost,
  computeInitialReservation,
  computeRefillDecision,
  computeSyncGrowRefillAmount,
  computeTopUpRefillAmount,
  thresholdFromBps,
  updateSpendVelocity,
} from "./reservation-sizing"

const DOLLAR = 100_000_000

function policy(overrides: Partial<ReservationPolicy> = {}): ReservationPolicy {
  return { ...DEFAULT_RESERVATION_POLICY, ...overrides }
}

describe("computeInitialReservation", () => {
  it("defaults to a 30 unit outstanding reservation cap", () => {
    expect(DEFAULT_RESERVATION_POLICY.maxOutstandingAmount).toBe(30 * DOLLAR)
  })

  it("does not force a $1 reservation for micro-priced events", () => {
    const result = computeInitialReservation({
      pricePerEventAmount: 2,
      currentEventCostAmount: 2,
      policy: policy({ softFloorAmount: 0 }),
    })

    expect(result.requestedAmount).toBe(50)
    expect(result.requestedAmount).toBeLessThan(DOLLAR)
    expect(result.canCoverCurrentEvent).toBe(true)
  })

  it("applies a soft floor only when configured", () => {
    const result = computeInitialReservation({
      pricePerEventAmount: 2,
      currentEventCostAmount: 2,
      policy: policy({ softFloorAmount: 1_000 }),
    })

    expect(result.requestedAmount).toBe(1_000)
  })

  it("covers an expensive current event even when cold-start events are smaller", () => {
    const result = computeInitialReservation({
      pricePerEventAmount: 1,
      currentEventCostAmount: 2 * DOLLAR,
      policy: policy({ maxOutstandingAmount: 3 * DOLLAR }),
    })

    expect(result.requestedAmount).toBe(2 * DOLLAR)
    expect(result.canCoverCurrentEvent).toBe(true)
  })

  it("caps cold-start-by-events without capping the current event first", () => {
    const result = computeInitialReservation({
      pricePerEventAmount: 10_000_000,
      currentEventCostAmount: 10_000_000,
      policy: policy({ maxColdStartAmount: DOLLAR, maxOutstandingAmount: 10 * DOLLAR }),
    })

    expect(result.requestedAmount).toBe(DOLLAR)
  })

  it("uses max outstanding as a safety cap", () => {
    const result = computeInitialReservation({
      pricePerEventAmount: 2 * DOLLAR,
      currentEventCostAmount: 2 * DOLLAR,
      policy: policy({ maxOutstandingAmount: DOLLAR }),
    })

    expect(result.requestedAmount).toBe(DOLLAR)
    expect(result.canCoverCurrentEvent).toBe(false)
  })

  it("requests nothing for free usage", () => {
    const result = computeInitialReservation({
      pricePerEventAmount: 0,
      currentEventCostAmount: 0,
    })

    expect(result.requestedAmount).toBe(0)
    expect(result.targetReservationAmount).toBe(0)
  })

  it("covers high-quantity low-price current events without jumping to $1", () => {
    const result = computeInitialReservation({
      pricePerEventAmount: 2,
      currentEventCostAmount: 100_000,
      policy: policy({ softFloorAmount: 0 }),
    })

    expect(result.requestedAmount).toBe(100_000)
    expect(result.requestedAmount).toBeLessThan(DOLLAR)
    expect(result.canCoverCurrentEvent).toBe(true)
  })
})

describe("updateSpendVelocity", () => {
  it("adapts upward for a fast meter", () => {
    const result = updateSpendVelocity({
      previousSpendEwmaAmount: 0,
      previousLastRateSampledAtMs: 1_000,
      flushAmount: 100,
      nowMs: 2_000,
    })

    expect(result.spendEwmaAmount).toBe(60_000)
    expect(result.lastRateSampledAtMs).toBe(2_000)
  })

  it("stays small for a slow meter", () => {
    const result = updateSpendVelocity({
      previousSpendEwmaAmount: 0,
      previousLastRateSampledAtMs: 0,
      flushAmount: 10,
      nowMs: 600_000,
    })

    expect(result.spendEwmaAmount).toBe(10)
  })

  it("smooths an existing EWMA by alpha", () => {
    const result = updateSpendVelocity({
      previousSpendEwmaAmount: 1_000,
      previousLastRateSampledAtMs: 0,
      flushAmount: 5_000,
      nowMs: 60_000,
      policy: policy({ ewmaAlphaBps: 2000, targetRefillIntervalMs: 60_000 }),
    })

    expect(result.spendEwmaAmount).toBe(1_800)
  })

  it("does not increase velocity for zero flushes", () => {
    const result = updateSpendVelocity({
      previousSpendEwmaAmount: 1_000,
      previousLastRateSampledAtMs: 0,
      flushAmount: 0,
      nowMs: 60_000,
    })

    expect(result.spendEwmaAmount).toBe(1_000)
    expect(result.lastRateSampledAtMs).toBe(60_000)
  })

  it("smooths downward after a spike instead of dropping immediately", () => {
    const result = updateSpendVelocity({
      previousSpendEwmaAmount: 10_000,
      previousLastRateSampledAtMs: 0,
      flushAmount: 10,
      nowMs: 300_000,
    })

    expect(result.spendEwmaAmount).toBe(8_004)
    expect(result.lastRateSampledAtMs).toBe(300_000)
  })

  it("uses one target interval when no previous sample time exists", () => {
    const result = updateSpendVelocity({
      previousSpendEwmaAmount: 0,
      previousLastRateSampledAtMs: null,
      flushAmount: 500,
      nowMs: 10_000,
    })

    expect(result.spendEwmaAmount).toBe(500)
    expect(result.lastRateSampledAtMs).toBe(10_000)
  })
})

describe("computeRefillDecision", () => {
  it("tops up to target", () => {
    expect(
      computeTopUpRefillAmount({
        remainingAmount: 2,
        targetReservationAmount: 10,
        maxOutstandingAmount: 100,
      })
    ).toBe(8)
  })

  it("respects max outstanding room", () => {
    expect(
      computeTopUpRefillAmount({
        remainingAmount: 9,
        targetReservationAmount: 20,
        maxOutstandingAmount: 10,
      })
    ).toBe(1)
  })

  it("bases threshold on target, not cumulative allocation", () => {
    const result = computeRefillDecision({
      allocationAmount: 100,
      consumedAmount: 98,
      flushedAmount: 90,
      targetReservationAmount: 10,
      spendEwmaAmount: 10,
      lastRateSampledAtMs: 0,
      maxEventCostAmount: 0,
      currentEventCostAmount: 0,
      pricePerEventAmount: 0,
      policy: policy({ refillLatencyBufferMs: 0 }),
    })

    expect(result.targetReservationAmount).toBe(10)
    expect(result.watermarkAmount).toBe(2)
    expect(result.needsRefill).toBe(true)
    expect(result.refillAmount).toBe(8)
  })

  it("caps adaptive target by max outstanding", () => {
    const result = computeRefillDecision({
      allocationAmount: 100,
      consumedAmount: 100,
      flushedAmount: 100,
      targetReservationAmount: 0,
      spendEwmaAmount: 10_000,
      lastRateSampledAtMs: 0,
      maxEventCostAmount: 0,
      currentEventCostAmount: 0,
      pricePerEventAmount: 0,
      policy: policy({ maxOutstandingAmount: 1_000 }),
    })

    expect(result.targetReservationAmount).toBe(1_000)
    expect(result.refillAmount).toBe(1_000)
  })

  it("raises the target for a sudden expensive event spike", () => {
    const result = computeRefillDecision({
      allocationAmount: 500,
      consumedAmount: 400,
      flushedAmount: 0,
      targetReservationAmount: 10,
      spendEwmaAmount: 10,
      lastRateSampledAtMs: 0,
      maxEventCostAmount: 10,
      currentEventCostAmount: 500,
      pricePerEventAmount: 500,
      policy: policy({ maxOutstandingAmount: 1_000 }),
    })

    expect(result.remainingAmount).toBe(100)
    expect(result.maxEventCostAmount).toBe(500)
    expect(result.targetReservationAmount).toBe(510)
    expect(result.watermarkAmount).toBe(500)
    expect(result.refillAmount).toBe(410)
  })

  it("can trigger refill from the latency buffer before the bps watermark", () => {
    const result = computeRefillDecision({
      allocationAmount: 500,
      consumedAmount: 430,
      flushedAmount: 0,
      targetReservationAmount: 0,
      spendEwmaAmount: 300,
      lastRateSampledAtMs: 0,
      maxEventCostAmount: 0,
      currentEventCostAmount: 0,
      pricePerEventAmount: 0,
      policy: policy({ refillLatencyBufferMs: 60_000, targetRefillIntervalMs: 300_000 }),
    })

    expect(result.remainingAmount).toBe(70)
    expect(result.targetReservationAmount).toBe(360)
    expect(result.watermarkAmount).toBe(72)
    expect(result.needsRefill).toBe(true)
    expect(result.refillAmount).toBe(290)
  })
})

describe("computeEffectiveWalletCost", () => {
  it("prevents negative corrections from reducing consumed below flushed", () => {
    const result = computeEffectiveWalletCost({
      requestedCostAmount: -5,
      consumedAmount: 10,
      flushedAmount: 8,
    })

    expect(result.effectiveCostAmount).toBe(-2)
    expect(result.clampedNegativeAmount).toBe(-3)
  })

  it("passes positive costs through unchanged", () => {
    const result = computeEffectiveWalletCost({
      requestedCostAmount: 7,
      consumedAmount: 10,
      flushedAmount: 8,
    })

    expect(result.effectiveCostAmount).toBe(7)
    expect(result.clampedNegativeAmount).toBe(0)
  })
})

describe("computeSyncGrowRefillAmount", () => {
  it("requests enough for the current event plus target buffer", () => {
    const result = computeSyncGrowRefillAmount({
      remainingAmount: 2,
      currentEventCostAmount: 5,
      targetReservationAmount: 10,
      maxOutstandingAmount: 20,
    })

    expect(result).toBe(13)
  })

  it("caps synchronous grow by max outstanding", () => {
    const result = computeSyncGrowRefillAmount({
      remainingAmount: 9,
      currentEventCostAmount: 20,
      targetReservationAmount: 20,
      maxOutstandingAmount: 10,
    })

    expect(result).toBe(1)
  })

  it("returns only available cap room when the current event is larger than the cap", () => {
    const result = computeSyncGrowRefillAmount({
      remainingAmount: 0,
      currentEventCostAmount: 20,
      targetReservationAmount: 10,
      maxOutstandingAmount: 10,
    })

    expect(result).toBe(10)
  })
})

describe("thresholdFromBps", () => {
  it("computes integer basis-point thresholds", () => {
    expect(thresholdFromBps(10, 2000)).toBe(2)
  })
})
