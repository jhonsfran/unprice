import { describe, expect, it, vi } from "vitest"
import { endAgentRun } from "./end-run"

const input = {
  agentId: "agt_123",
  runId: "arun_123",
  customerId: "cus_123",
  projectId: "proj_123",
  endedAt: new Date("2026-06-15T12:00:00.000Z"),
  status: "completed" as const,
}

describe("endAgentRun", () => {
  it("denies when the run does not belong to the agent customer and project", async () => {
    const result = await endAgentRun(
      {
        services: {
          agents: { getRunForAgent: vi.fn().mockResolvedValue(null) },
        },
        runBudget: { endRun: vi.fn() },
      } as never,
      input
    )

    expect(result.err?.message).toBe("RUN_NOT_FOUND")
  })

  it("delegates finalization to the run budget port", async () => {
    const runBudget = {
      endRun: vi.fn().mockResolvedValue({
        runId: "arun_123",
        status: "completed",
        budgetAmount: 100_000_000,
        consumedAmount: 25_000_000,
        remainingAmount: 75_000_000,
      }),
    }

    const result = await endAgentRun(
      {
        services: {
          agents: {
            getRunForAgent: vi.fn().mockResolvedValue({
              id: "arun_123",
              agentId: "agt_123",
              customerId: "cus_123",
              projectId: "proj_123",
              status: "running",
            }),
          },
        },
        runBudget,
      } as never,
      input
    )

    expect(result.val?.status).toBe("completed")
    expect(runBudget.endRun).toHaveBeenCalledWith(input)
  })
})
