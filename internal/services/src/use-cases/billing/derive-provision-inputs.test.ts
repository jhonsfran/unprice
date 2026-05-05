import type { Database } from "@unprice/db"
import { dinero } from "dinero.js"
import { USD } from "dinero.js/currencies"
import { describe, expect, it, vi } from "vitest"
import {
  CEILING_AMOUNT,
  DEFAULT_REFILL_THRESHOLD_BPS,
  MINIMUM_FLOOR_AMOUNT,
  deriveActivationInputsFromPlan,
  derivePeriodUsageAllowanceAmount,
  sizeReservation,
} from "./derive-provision-inputs"

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

const projectId = "prj_abc"
const subscriptionId = "sub_abc"

function usageUnitFeature({
  amount,
  limit,
}: {
  amount: number
  limit: number | null
}) {
  return {
    featureType: "usage" as const,
    limit,
    config: {
      usageMode: "unit" as const,
      price: {
        dinero: dinero({ amount, currency: USD }).toJSON(),
        displayAmount: String(amount / 100),
      },
    },
  }
}

function createDb(planVersion: {
  whenToBill: string
  creditLineAmount: number
  planFeatures: Array<ReturnType<typeof usageUnitFeature>>
}): Database {
  return {
    query: {
      subscriptions: {
        findFirst: vi.fn(async () => ({
          id: subscriptionId,
          projectId,
          customer: { id: "cus_abc", defaultCurrency: "USD" },
          phases: [{ planVersion }],
        })),
      },
    },
  } as unknown as Database
}

describe("derivePeriodUsageAllowanceAmount", () => {
  it("uses the explicit period usage allowance when present", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        whenToBill: "pay_in_arrear",
        creditLineAmount: 12_000_000_000,
        planFeatures: [usageUnitFeature({ amount: 50, limit: 10 })],
      })
    ).toBe(12_000_000_000)
  })

  it("derives arrears allowance from finite priced usage limits", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        whenToBill: "pay_in_arrear",
        creditLineAmount: 0,
        planFeatures: [usageUnitFeature({ amount: 50, limit: 10 })],
      })
    ).toBe(500_000_000)
  })

  it("does not infer credit for unlimited paid usage", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        whenToBill: "pay_in_arrear",
        creditLineAmount: 0,
        planFeatures: [usageUnitFeature({ amount: 50, limit: null })],
      })
    ).toBe(0)
  })

  it("does not derive a default for advance billing", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        whenToBill: "pay_in_advance",
        creditLineAmount: 0,
        planFeatures: [usageUnitFeature({ amount: 50, limit: 10 })],
      })
    ).toBe(0)
  })
})

describe("deriveActivationInputsFromPlan", () => {
  it("issues a credit_line grant for the derived period usage allowance", async () => {
    const result = await deriveActivationInputsFromPlan(
      createDb({
        whenToBill: "pay_in_arrear",
        creditLineAmount: 0,
        planFeatures: [usageUnitFeature({ amount: 50, limit: 10 })],
      }),
      { subscriptionId, projectId }
    )

    expect(result?.grants).toEqual([
      {
        amount: 500_000_000,
        source: "credit_line",
        reason: "Period usage allowance",
      },
    ])
  })
})
