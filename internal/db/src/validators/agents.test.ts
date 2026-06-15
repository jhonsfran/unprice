import { describe, expect, it } from "vitest"
import { agentRunStatusSchema, createAgentInputSchema, startAgentRunInputSchema } from "./agents"

describe("agent validators", () => {
  it("accepts the minimal agent creation contract", () => {
    expect(
      createAgentInputSchema.parse({
        projectId: "proj_123",
        name: "Support agent",
      })
    ).toEqual({
      projectId: "proj_123",
      name: "Support agent",
      description: null,
      metadata: {},
    })
  })

  it("accepts the run start contract with a strict run budget", () => {
    expect(
      startAgentRunInputSchema.parse({
        agentId: "agt_123",
        customerId: "cus_123",
        projectId: "proj_123",
        currency: "USD",
        budgetAmount: 25_000_000,
        idempotencyKey: "run-start-123",
        traceId: "trace_123",
      })
    ).toMatchObject({
      agentId: "agt_123",
      customerId: "cus_123",
      projectId: "proj_123",
      currency: "USD",
      budgetAmount: 25_000_000,
      metadata: {},
    })
  })

  it("keeps run lifecycle values explicit", () => {
    expect(agentRunStatusSchema.options).toEqual([
      "running",
      "completed",
      "expired",
      "canceled",
      "budget_exceeded",
      "failed",
    ])
  })
})
