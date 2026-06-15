import { describe, expect, it, vi } from "vitest"
import { applyAgentRunSyncEvent } from "./apply-run-sync-event"

const input = {
  agentId: "agt_123",
  runId: "arun_123",
  customerId: "cus_123",
  projectId: "proj_123",
  featureSlug: "tokens",
  idempotencyKey: "idem_123",
  event: {
    id: "evt_123",
    slug: "tokens_used",
    timestamp: 1_781_503_200_000,
    properties: { amount: 1 },
  },
  source: {
    workspaceId: "ws_123",
    environment: "development",
    apiKeyId: "api_123",
    sourceType: "api_key" as const,
    sourceId: "api_123",
    sourceName: null,
  },
  now: 1_781_503_200_100,
}

describe("applyAgentRunSyncEvent", () => {
  it("denies when the run does not belong to the agent customer and project", async () => {
    const result = await applyAgentRunSyncEvent(
      {
        services: {
          agents: { getRunForAgent: vi.fn().mockResolvedValue(null) },
        },
        runBudget: { applySyncEvent: vi.fn() },
      } as never,
      input
    )

    expect(result.err?.message).toBe("RUN_NOT_FOUND")
  })

  it("delegates sync ingestion to the run budget port", async () => {
    const runBudget = {
      applySyncEvent: vi.fn().mockResolvedValue({
        allowed: true,
        state: "processed",
        budget: {
          runId: "arun_123",
          status: "running",
          budgetAmount: 100_000_000,
          consumedAmount: 1_000_000,
          remainingAmount: 99_000_000,
        },
      }),
    }

    const result = await applyAgentRunSyncEvent(
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

    expect(result.val?.state).toBe("processed")
    expect(runBudget.applySyncEvent).toHaveBeenCalledWith(input)
  })
})
