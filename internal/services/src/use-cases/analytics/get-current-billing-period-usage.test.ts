import { Err } from "@unprice/error"
import { describe, expect, it } from "vitest"
import { UnPriceBudgetError } from "../../budgets"
import { meterPayerUsage } from "../budgets/meter-payer-usage"
import { DEC, NOV, PROJECT_ID, image, payerHarness } from "../budgets/payer-budget.fixture"
import { getCurrentBillingPeriodUsage } from "./get-current-billing-period-usage"

const projectId = PROJECT_ID
const customerId = "cus_123"

describe("getCurrentBillingPeriodUsage", () => {
  it("reads the open statements of the payer budget, priced at ingestion", async () => {
    const h = payerHarness()
    await h.createPayer(customerId)
    await meterPayerUsage(h.deps, {
      verb: "record",
      receivedAt: h.clock.now,
      events: [
        { projectId, customerId, idempotencyKey: "e1", occurredAt: NOV + 1, ...image("1024") },
        { projectId, customerId, idempotencyKey: "e2", occurredAt: NOV + 2, ...image("512") },
      ],
    })

    const result = await getCurrentBillingPeriodUsage(
      { budgets: h.budgets, now: () => h.clock.now },
      { projectId, customerId }
    )

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({
      billingPeriods: [
        {
          id: "bp_nov",
          cycleStartAt: NOV,
          cycleEndAt: DEC,
          usage: [{ featureSlug: "images", usage: 2, amount: "0.058", unit: "money:USD" }],
        },
      ],
    })
  })

  it("leaves out statements that do not cover now", async () => {
    const h = payerHarness()
    await h.createPayer(customerId)
    const result = await getCurrentBillingPeriodUsage(
      { budgets: h.budgets, now: () => DEC + 1 },
      { projectId, customerId }
    )
    expect(result.val).toEqual({ billingPeriods: [] })
  })

  it("answers no periods for a customer without a payer budget", async () => {
    const h = payerHarness()
    const result = await getCurrentBillingPeriodUsage(
      { budgets: h.budgets, now: () => h.clock.now },
      { projectId, customerId: "cus_none" }
    )
    expect(result.val).toEqual({ billingPeriods: [] })
  })

  it("returns any other budget failure", async () => {
    const failure = new UnPriceBudgetError({ code: "BUDGET_CLOSED", closedAt: 1 })
    const result = await getCurrentBillingPeriodUsage(
      {
        budgets: { execute: async () => Err(failure), cacheCards: async () => {} },
        now: () => NOV,
      },
      { projectId, customerId }
    )
    expect(result.err).toBe(failure)
  })
})
