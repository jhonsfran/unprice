import type { Database } from "@unprice/db"
import { fromLedgerAmount, toLedgerMinor } from "@unprice/money"
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

const ledger = (amount: string) => toLedgerMinor(fromLedgerAmount(amount, "USD"))
const DOLLAR = ledger("1")

describe("sizeReservation", () => {
  it("floors at $1 for sub-cent meters (formula product below the floor)", () => {
    // $0.0001 per event * 1000 = $0.10 — below the $1 floor.
    const sizing = sizeReservation(ledger("0.0001"))
    expect(sizing.requestedAmount).toBe(MINIMUM_FLOOR_AMOUNT)
    expect(sizing.refillThresholdBps).toBe(DEFAULT_REFILL_THRESHOLD_BPS)
    expect(sizing.refillChunkAmount).toBe(MINIMUM_FLOOR_AMOUNT / 4)
  })

  it("uses 1000 * pricePerEvent in the mid-range", () => {
    // $0.003 per event * 1000 = $3 — between floor and ceiling.
    const sizing = sizeReservation(ledger("0.003"))
    expect(sizing.requestedAmount).toBe(3 * DOLLAR)
    expect(sizing.refillChunkAmount).toBe(Math.floor((3 * DOLLAR) / 4))
  })

  it("caps at $10 for expensive meters", () => {
    // $0.50 per event * 1000 = $500 — above the ceiling.
    const sizing = sizeReservation(ledger("0.50"))
    expect(sizing.requestedAmount).toBe(CEILING_AMOUNT)
    expect(sizing.refillChunkAmount).toBe(CEILING_AMOUNT / 4)
  })

  it("hits the boundary exactly at $1 floor", () => {
    // $0.001 per event * 1000 = $1 — exactly at the floor.
    const sizing = sizeReservation(ledger("0.001"))
    expect(sizing.requestedAmount).toBe(MINIMUM_FLOOR_AMOUNT)
  })

  it("hits the boundary exactly at $10 ceiling", () => {
    // $0.01 per event * 1000 = $10 — exactly at the ceiling.
    const sizing = sizeReservation(ledger("0.01"))
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

function createDb(phase: {
  creditLinePolicy: "capped" | "uncapped"
  creditLineAmount: number | null
  planVersion: {
    planFeatures: Array<ReturnType<typeof usageUnitFeature>>
  }
}): Database {
  return {
    query: {
      subscriptions: {
        findFirst: vi.fn(async () => ({
          id: subscriptionId,
          projectId,
          customer: { id: "cus_abc", defaultCurrency: "USD" },
          phases: [phase],
        })),
      },
    },
  } as unknown as Database
}

describe("derivePeriodUsageAllowanceAmount", () => {
  it("uses the explicit period usage allowance when present", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        creditLinePolicy: "capped",
        creditLineAmount: ledger("120"),
        planVersion: {
          planFeatures: [usageUnitFeature({ amount: 50, limit: 10 })],
        },
      })
    ).toBe(ledger("120"))
  })

  it("derives capped allowance from finite priced usage limits", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        creditLinePolicy: "capped",
        creditLineAmount: null,
        planVersion: {
          planFeatures: [usageUnitFeature({ amount: 50, limit: 10 })],
        },
      })
    ).toBe(ledger("5"))
  })

  it("does not infer credit for unlimited paid usage", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        creditLinePolicy: "capped",
        creditLineAmount: null,
        planVersion: {
          planFeatures: [usageUnitFeature({ amount: 50, limit: null })],
        },
      })
    ).toBe(0)
  })

  it("treats zero as an explicit capped amount", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        creditLinePolicy: "capped",
        creditLineAmount: 0,
        planVersion: {
          planFeatures: [usageUnitFeature({ amount: 50, limit: 10 })],
        },
      })
    ).toBe(0)
  })

  it("does not mint wallet credit for uncapped usage", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        creditLinePolicy: "uncapped",
        creditLineAmount: ledger("120"),
        planVersion: {
          planFeatures: [usageUnitFeature({ amount: 50, limit: 10 })],
        },
      })
    ).toBe(0)
  })
})

describe("deriveActivationInputsFromPlan", () => {
  it("issues a credit_line grant for the derived period usage allowance", async () => {
    const result = await deriveActivationInputsFromPlan(
      createDb({
        creditLinePolicy: "capped",
        creditLineAmount: null,
        planVersion: {
          planFeatures: [usageUnitFeature({ amount: 50, limit: 10 })],
        },
      }),
      { subscriptionId, projectId }
    )

    expect(result?.grants).toEqual([
      {
        amount: ledger("5"),
        source: "credit_line",
        reason: "Period usage allowance",
      },
    ])
  })

  it("returns the uncapped policy without issuing a credit_line grant", async () => {
    const result = await deriveActivationInputsFromPlan(
      createDb({
        creditLinePolicy: "uncapped",
        creditLineAmount: null,
        planVersion: {
          planFeatures: [usageUnitFeature({ amount: 50, limit: 10 })],
        },
      }),
      { subscriptionId, projectId }
    )

    expect(result).toEqual({
      creditLinePolicy: "uncapped",
      grants: [],
    })
  })
})
