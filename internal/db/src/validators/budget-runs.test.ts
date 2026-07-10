import { describe, expect, it } from "vitest"
import { runSummarySchema, startRunInputSchema } from "./budget-runs"

describe("budget run validators", () => {
  it("accepts workload, trace, and parent attribution on start without currency", () => {
    const input = startRunInputSchema.parse({
      budgetAmountMinor: 100,
      idempotencyKey: "idem_run_attr",
      workloadType: "workflow",
      workloadId: "checkout-flow",
      traceId: "trace_123",
      parentRunId: "brun_parent_123",
    })

    expect(input).toEqual({
      budgetAmountMinor: 100,
      idempotencyKey: "idem_run_attr",
      workloadType: "workflow",
      workloadId: "checkout-flow",
      traceId: "trace_123",
      parentRunId: "brun_parent_123",
    })
  })

  it("requires the public start budget amount to name minor units", () => {
    const result = startRunInputSchema.safeParse({
      budgetAmount: 100,
      idempotencyKey: "idem_old_budget_amount",
    })

    expect(result.success).toBe(false)
  })

  it("does not expose agentId in the run summary contract", () => {
    const summary = runSummarySchema.parse({
      runId: "brun_123",
      status: "running",
      endedAt: null,
      customerId: "cus_123",
      budgetAmountMinor: 100,
      consumedAmountMinor: 0,
      remainingAmountMinor: 100,
      currency: "USD",
      workloadType: "agent",
      workloadId: "research-assistant",
      traceId: "trace_123",
      parentRunId: null,
    })

    expect(summary).toMatchObject({
      workloadType: "agent",
      endedAt: null,
      workloadId: "research-assistant",
      traceId: "trace_123",
      parentRunId: null,
    })
    expect(summary).not.toHaveProperty("agentId")
  })
})
