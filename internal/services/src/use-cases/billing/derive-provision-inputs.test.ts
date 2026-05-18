import type { Database } from "@unprice/db"
import { fromLedgerAmount, toLedgerMinor } from "@unprice/money"
import { dinero } from "dinero.js"
import { USD } from "dinero.js/currencies"
import { describe, expect, it, vi } from "vitest"
import {
  deriveActivationInputsFromPlan,
  derivePeriodUsageAllowanceAmount,
} from "./derive-provision-inputs"

const ledger = (amount: string) => toLedgerMinor(fromLedgerAmount(amount, "USD"))

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
