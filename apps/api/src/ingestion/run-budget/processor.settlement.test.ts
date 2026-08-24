import { describe, expect, it } from "vitest"
import {
  RUN_BUDGET_TEST_NOW,
  createRunBudgetMeterFact,
  createRunBudgetProcessorHarness,
} from "./testing/harness"
import { createRunBudgetApplyInput, createRunBudgetStartInput } from "./testing/processor-contract"

describe("RunBudgetProcessor settlement", () => {
  it("records incurred usage without enforcing the feature limit and leaves the run open", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(createRunBudgetStartInput())

    const decision = await harness.processor.settleRun(createRunBudgetApplyInput())

    expect(harness.pricingApply).toHaveBeenCalledWith(
      expect.objectContaining({ enforceLimit: false })
    )
    expect(decision).toMatchObject({
      allowed: true,
      fundingStatus: "fully_funded",
      fundedAmount: 5_000,
      unfundedAmount: 0,
      budget: {
        status: "running",
        endedAt: null,
        budgetAmount: 10_000,
        consumedAmount: 5_000,
        remainingAmount: 5_000,
      },
    })
    expect(harness.captureReservationUsage).not.toHaveBeenCalled()
    expect(harness.releaseReservation).not.toHaveBeenCalled()
  })

  it("records full usage while keeping capture inside the original reservation", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(createRunBudgetStartInput({ budgetAmount: 4_000 }))
    harness.pricingApply.mockResolvedValueOnce({
      allowed: true,
      meterFacts: [createRunBudgetMeterFact({ amount: 5_000, delta: 5 })],
    })

    const decision = await harness.processor.settleRun(
      createRunBudgetApplyInput({ idempotencyKey: "settle_over_budget" })
    )

    expect(decision).toMatchObject({
      allowed: true,
      state: "processed",
      fundingStatus: "partially_funded",
      fundedAmount: 4_000,
      unfundedAmount: 1_000,
      budget: {
        status: "running",
        budgetAmount: 4_000,
        consumedAmount: 5_000,
        remainingAmount: 0,
      },
      meterFacts: [expect.objectContaining({ amount: 5_000, delta: 5 })],
    })
    expect(harness.walletCreate).toHaveBeenCalledTimes(1)

    await harness.processor.endRun({
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      status: "completed",
      endedAt: RUN_BUDGET_TEST_NOW + 2_000,
    })

    expect(harness.captureReservationUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 4_000,
        metadata: expect.objectContaining({ quantity: 4 }),
      })
    )
    expect(harness.releaseReservation).toHaveBeenCalledTimes(1)
  })

  it("keeps later incurred usage recordable after the reservation is exhausted", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(createRunBudgetStartInput({ budgetAmount: 10_000 }))

    const settle = async (idempotencyKey: string, amount: number, quantity: number) => {
      harness.pricingApply.mockResolvedValueOnce({
        allowed: true,
        meterFacts: [createRunBudgetMeterFact({ amount, delta: quantity })],
      })
      return harness.processor.settleRun(createRunBudgetApplyInput({ idempotencyKey }))
    }

    const first = await settle("turn_1", 6_000, 6)
    expect(first).toMatchObject({
      allowed: true,
      fundingStatus: "fully_funded",
      fundedAmount: 6_000,
      unfundedAmount: 0,
      budget: { budgetAmount: 10_000, consumedAmount: 6_000, remainingAmount: 4_000 },
    })

    const crossing = await settle("turn_2", 5_000, 5)
    expect(crossing).toMatchObject({
      allowed: true,
      fundingStatus: "partially_funded",
      fundedAmount: 4_000,
      unfundedAmount: 1_000,
      budget: { budgetAmount: 10_000, consumedAmount: 11_000, remainingAmount: 0 },
    })

    const above = await settle("turn_3", 2_000, 2)
    expect(above).toMatchObject({
      allowed: true,
      fundingStatus: "unfunded",
      fundedAmount: 0,
      unfundedAmount: 2_000,
      budget: { budgetAmount: 10_000, consumedAmount: 13_000, remainingAmount: 0 },
    })

    await expect(
      harness.processor.settleRun(createRunBudgetApplyInput({ idempotencyKey: "turn_2" }))
    ).resolves.toEqual(crossing)
    expect(harness.pricingApply).toHaveBeenCalledTimes(3)

    await harness.processor.endRun({
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      status: "completed",
      endedAt: RUN_BUDGET_TEST_NOW + 4_000,
    })

    expect(harness.captureReservationUsage).toHaveBeenCalledTimes(1)
    expect(harness.captureReservationUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 10_000,
        metadata: expect.objectContaining({ quantity: 10 }),
      })
    )
    await expect(
      harness.processor.getRunStatus({
        runId: "run_1",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({
      status: "completed",
      budgetAmount: 10_000,
      consumedAmount: 13_000,
      remainingAmount: 0,
    })
  })
})
