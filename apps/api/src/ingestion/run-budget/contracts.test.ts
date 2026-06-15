import { describe, expect, it } from "vitest"
import {
  applyRunSyncEventInputSchema,
  runBudgetDecisionSchema,
  startRunInputSchema,
} from "./contracts"

describe("run budget contracts", () => {
  it("parses startRun input", () => {
    expect(
      startRunInputSchema.parse({
        agentId: "agt_123",
        runId: "arun_123",
        customerId: "cus_123",
        projectId: "proj_123",
        currency: "USD",
        budgetAmount: 100_000_000,
        idempotencyKey: "start-1",
        now: 1_781_503_200_000,
        metadata: {},
      })
    ).toMatchObject({ runId: "arun_123", budgetAmount: 100_000_000 })
  })

  it("requires an idempotency key for run sync events", () => {
    const result = applyRunSyncEventInputSchema.safeParse({
      agentId: "agt_123",
      runId: "arun_123",
      customerId: "cus_123",
      projectId: "proj_123",
      featureSlug: "tokens",
      event: { id: "evt_123", slug: "tokens_used", timestamp: 1, properties: {} },
      source: {
        workspaceId: "ws_123",
        environment: "development",
        apiKeyId: "api_123",
        sourceType: "api_key",
        sourceId: "api_123",
        sourceName: null,
      },
      now: 1,
    })

    expect(result.success).toBe(false)
  })

  it("allows run budget exceeded as a sync denial reason", () => {
    expect(
      runBudgetDecisionSchema.parse({
        allowed: false,
        state: "rejected",
        rejectionReason: "RUN_BUDGET_EXCEEDED",
        message: "Run budget exceeded",
        budget: {
          runId: "arun_123",
          status: "budget_exceeded",
          budgetAmount: 100,
          consumedAmount: 100,
          remainingAmount: 0,
        },
      })
    ).toMatchObject({ rejectionReason: "RUN_BUDGET_EXCEEDED" })
  })
})
