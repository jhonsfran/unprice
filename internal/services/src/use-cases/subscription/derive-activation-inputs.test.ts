import { describe, expect, it } from "vitest"
import {
  CEILING_AMOUNT,
  DEFAULT_REFILL_THRESHOLD_BPS,
  MINIMUM_FLOOR_AMOUNT,
  sizeReservation,
} from "./derive-activation-inputs"

const DOLLAR = 100_000_000

describe("sizeReservation", () => {
  it("floors at $1 for sub-cent meters (formula product below the floor)", () => {
    // $0.0001 per event * 1000 = $0.10 — below the $1 floor.
    const sizing = sizeReservation(10_000) // $0.0001 at scale 8
    expect(sizing.requestedAmount).toBe(MINIMUM_FLOOR_AMOUNT)
    expect(sizing.refillThresholdBps).toBe(DEFAULT_REFILL_THRESHOLD_BPS)
    expect(sizing.refillChunkAmount).toBe(MINIMUM_FLOOR_AMOUNT / 4)
  })

  it("uses 1000 * pricePerEvent in the mid-range", () => {
    // $0.003 per event * 1000 = $3 — between floor and ceiling.
    const sizing = sizeReservation(300_000) // $0.003 at scale 8
    expect(sizing.requestedAmount).toBe(3 * DOLLAR)
    expect(sizing.refillChunkAmount).toBe(Math.floor((3 * DOLLAR) / 4))
  })

  it("caps at $10 for expensive meters", () => {
    // $0.50 per event * 1000 = $500 — above the ceiling.
    const sizing = sizeReservation(50_000_000) // $0.50 at scale 8
    expect(sizing.requestedAmount).toBe(CEILING_AMOUNT)
    expect(sizing.refillChunkAmount).toBe(CEILING_AMOUNT / 4)
  })

  it("hits the boundary exactly at $1 floor", () => {
    // $0.001 per event * 1000 = $1 — exactly at the floor.
    const sizing = sizeReservation(100_000) // $0.001
    expect(sizing.requestedAmount).toBe(MINIMUM_FLOOR_AMOUNT)
  })

  it("hits the boundary exactly at $10 ceiling", () => {
    // $0.01 per event * 1000 = $10 — exactly at the ceiling.
    const sizing = sizeReservation(1_000_000) // $0.01
    expect(sizing.requestedAmount).toBe(CEILING_AMOUNT)
  })
})
