import { describe, expect, it, vi } from "vitest"
import { startAgentRun } from "./start-run"

describe("startAgentRun", () => {
  it("denies when the agent is not active in the project", async () => {
    const result = await startAgentRun(
      {
        services: {
          agents: { getActiveAgent: vi.fn().mockResolvedValue(null) },
        },
        runBudget: { startRun: vi.fn() },
      } as never,
      {
        agentId: "agt_123",
        customerId: "cus_123",
        projectId: "proj_123",
        currency: "USD",
        budgetAmount: 100_000_000,
        idempotencyKey: "start-1",
        metadata: {},
      }
    )

    expect(result.err?.message).toBe("AGENT_NOT_FOUND")
  })

  it("delegates run admission to the run budget port", async () => {
    const runBudget = {
      startRun: vi.fn().mockResolvedValue({
        runId: "arun_123",
        status: "running",
        budgetAmount: 100_000_000,
        consumedAmount: 0,
        remainingAmount: 100_000_000,
      }),
    }

    const result = await startAgentRun(
      {
        services: {
          agents: {
            getActiveAgent: vi.fn().mockResolvedValue({ id: "agt_123", projectId: "proj_123" }),
          },
        },
        runBudget,
      } as never,
      {
        agentId: "agt_123",
        customerId: "cus_123",
        projectId: "proj_123",
        currency: "USD",
        budgetAmount: 100_000_000,
        idempotencyKey: "start-1",
        metadata: {},
      }
    )

    expect(result.val?.runId).toBe("arun_123")
    expect(runBudget.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agt_123",
        customerId: "cus_123",
        projectId: "proj_123",
      })
    )
  })
})
