import { beforeEach, describe, expect, it, vi } from "vitest"
import { AgentService } from "./service"

const db = {
  insert: vi.fn(),
  update: vi.fn(),
  query: {
    agents: { findFirst: vi.fn(), findMany: vi.fn() },
    agentRuns: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: vi.fn(() => logger) }

beforeEach(() => {
  vi.clearAllMocks()
})

describe("AgentService", () => {
  it("returns null when an active agent is not found for a project", async () => {
    db.query.agents.findFirst.mockResolvedValue(null)
    const service = new AgentService({ db: db as never, logger: logger as never })

    const result = await service.getActiveAgent({
      agentId: "agt_123",
      projectId: "proj_123",
    })

    expect(result).toBeNull()
  })

  it("reads a run by project agent customer and run id", async () => {
    db.query.agentRuns.findFirst.mockResolvedValue({
      id: "arun_123",
      agentId: "agt_123",
      customerId: "cus_123",
      projectId: "proj_123",
      status: "running",
    })
    const service = new AgentService({ db: db as never, logger: logger as never })

    const result = await service.getRunForAgent({
      agentId: "agt_123",
      customerId: "cus_123",
      projectId: "proj_123",
      runId: "arun_123",
    })

    expect(result).toMatchObject({ id: "arun_123", status: "running" })
  })
})
