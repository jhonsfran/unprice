import { describe, expect, it } from "vitest"
import { runSummarySchema, startRunInputSchema, toRunSummaryMinor } from "./budget-runs"

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

  describe("toRunSummaryMinor", () => {
    const ledgerBase = {
      runId: "brun_123",
      status: "running" as const,
      endedAt: null,
      customerId: "cus_123",
      workloadType: "agent" as const,
      workloadId: "research-assistant",
      traceId: "trace_123",
      parentRunId: null,
    }

    it("converts ledger-scale amounts (scale 8) to currency minor units", () => {
      const result = toRunSummaryMinor({
        ...ledgerBase,
        currency: "USD",
        budgetAmount: 50_00_000_000, // $50.00 at pgledger scale 8
        consumedAmount: 12_50_000_000, // $12.50
        remainingAmount: 37_50_000_000, // $37.50
      })

      expect(result.budgetAmountMinor).toBe(5000)
      expect(result.consumedAmountMinor).toBe(1250)
      expect(result.remainingAmountMinor).toBe(3750)
      // The raw ledger fields are dropped from the API-facing summary.
      expect(result).not.toHaveProperty("budgetAmount")
      expect(runSummarySchema.safeParse(result).success).toBe(true)
    })

    it("honors the run currency rather than assuming USD", () => {
      const result = toRunSummaryMinor({
        ...ledgerBase,
        currency: "EUR",
        budgetAmount: 1_00_000_000, // €1.00
        consumedAmount: 0,
        remainingAmount: 1_00_000_000,
      })

      expect(result.currency).toBe("EUR")
      expect(result.budgetAmountMinor).toBe(100)
    })
  })
})
