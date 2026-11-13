import type { Database } from "@unprice/db"
import { describe, expect, it, vi } from "vitest"
import { createRecordedUsageFixture } from "./recorded-usage"

const input = {
  projectId: "proj_fixture",
  customerId: "cus_fixture",
  statementKey: "stmt_fixture",
  at: 200,
}

describe("recorded usage fixture", () => {
  it("seals the accepted usage of each metered period, once", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "bp_fixture",
        statementKey: "stmt_fixture",
        cycleStartAt: 100,
        cycleEndAt: 200,
        subscriptionItem: {
          featurePlanVersion: { featureType: "usage", feature: { slug: "events" } },
        },
      },
    ])
    const db = { query: { billingPeriods: { findMany } } } as unknown as Database
    const { payerBudgets } = createRecordedUsageFixture(db, {
      events: { amount: 1_000_000_000, quantity: 10 },
    })

    const first = await payerBudgets.seal(input)
    const second = await payerBudgets.seal(input)

    expect(first.val?.sealed).toEqual([
      expect.objectContaining({
        periodId: "bp_fixture",

        amount: "1000000000",
        quantity: "1000000000",
      }),
    ])
    expect(second.val).toEqual(first.val)
  })
})
