import { OpenAPIHono } from "@hono/zod-openapi"
import type { ExecutionContext } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { registerApplyAgentRunSyncEventV1 } from "./applyAgentRunSyncEventV1"
import { registerCreateAgentV1 } from "./createAgentV1"
import { registerEndAgentRunV1 } from "./endAgentRunV1"
import { registerGetAgentRunV1 } from "./getAgentRunV1"
import { registerListAgentsV1 } from "./listAgentsV1"
import { registerStartAgentRunV1 } from "./startAgentRunV1"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
}))

vi.mock("~/auth/key", () => ({
  keyAuth: authMocks.keyAuth,
  resolveContextProjectId: vi.fn((_c: unknown, projectId: string) => projectId),
}))

// Mock the use cases
const useCaseMocks = vi.hoisted(() => ({
  startAgentRun: vi.fn(),
  applyAgentRunSyncEvent: vi.fn(),
  endAgentRun: vi.fn(),
}))

vi.mock("@unprice/services/use-cases", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    startAgentRun: useCaseMocks.startAgentRun,
    applyAgentRunSyncEvent: useCaseMocks.applyAgentRunSyncEvent,
    endAgentRun: useCaseMocks.endAgentRun,
  }
})

// Mock the CloudflareRunBudgetClient
const runBudgetMocks = vi.hoisted(() => ({
  getRunStatus: vi.fn(),
}))

vi.mock("~/ingestion/run-budget/client", () => ({
  CloudflareRunBudgetClient: vi.fn().mockImplementation(() => ({
    startRun: vi.fn(),
    applySyncEvent: vi.fn(),
    endRun: vi.fn(),
    getRunStatus: runBudgetMocks.getRunStatus,
  })),
}))

const verifiedKey = {
  id: "key_123",
  projectId: "proj_123",
  project: {
    id: "proj_123",
    workspaceId: "ws_123",
    isInternal: false,
    isMain: false,
    workspace: {
      unPriceCustomerId: null,
    },
  },
}

beforeEach(() => {
  authMocks.keyAuth.mockResolvedValue(verifiedKey)
})

afterEach(() => {
  vi.clearAllMocks()
})

function createTestApp(mocks?: { agents?: Record<string, unknown> }) {
  const app = new OpenAPIHono<HonoEnv>()

  const agentsMock = mocks?.agents ?? {
    createAgent: vi.fn(),
    listAgents: vi.fn(),
    getActiveAgent: vi.fn(),
    getRunForAgent: vi.fn(),
  }

  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }
    throw error
  })

  app.use("*", async (c, next) => {
    c.set("services", {
      agents: agentsMock,
    } as unknown as HonoEnv["Variables"]["services"])
    await next()
  })

  registerCreateAgentV1(app)
  registerListAgentsV1(app)
  registerStartAgentRunV1(app)
  registerApplyAgentRunSyncEventV1(app)
  registerEndAgentRunV1(app)
  registerGetAgentRunV1(app)

  const env = { APP_ENV: "development" }
  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx, agentsMock }
}

describe("createAgentV1", () => {
  it("returns 200 and calls services.agents.createAgent", async () => {
    const createdAgent = {
      id: "agent_1",
      projectId: "proj_123",
      name: "my-agent",
      description: null,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    }

    const createAgent = vi.fn().mockResolvedValue(createdAgent)
    const { app, env, executionCtx } = createTestApp({
      agents: {
        createAgent,
        listAgents: vi.fn(),
        getActiveAgent: vi.fn(),
        getRunForAgent: vi.fn(),
      },
    })

    const response = await app.fetch(
      new Request("https://example.com/v1/agents", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "my-agent" }),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ id: "agent_1", name: "my-agent" })
    expect(createAgent).toHaveBeenCalledWith({
      projectId: "proj_123",
      name: "my-agent",
      description: null,
      metadata: {},
    })
  })
})

describe("listAgentsV1", () => {
  it("returns 200 with list of agents", async () => {
    const agentsList = [
      { id: "agent_1", projectId: "proj_123", name: "agent-a", description: null, metadata: {} },
    ]

    const listAgents = vi.fn().mockResolvedValue(agentsList)
    const { app, env, executionCtx } = createTestApp({
      agents: {
        createAgent: vi.fn(),
        listAgents,
        getActiveAgent: vi.fn(),
        getRunForAgent: vi.fn(),
      },
    })

    const response = await app.fetch(
      new Request("https://example.com/v1/agents", {
        method: "GET",
        headers: { authorization: "Bearer sk_test" },
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ agents: agentsList })
    expect(listAgents).toHaveBeenCalledWith({ projectId: "proj_123" })
  })
})

describe("startAgentRunV1", () => {
  it("returns 200 with budget summary on success", async () => {
    const budgetSummary = {
      runId: "run_1",
      status: "running",
      budgetAmount: 1000,
      consumedAmount: 0,
      remainingAmount: 1000,
    }

    useCaseMocks.startAgentRun.mockResolvedValue({ val: budgetSummary, err: undefined })

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      new Request("https://example.com/v1/agents/agent_123/runs", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          customerId: "cus_123",
          currency: "usd",
          budgetAmount: 1000,
          idempotencyKey: "idem_1",
        }),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual(budgetSummary)
  })

  it("returns 404 when agent not found", async () => {
    const { AgentRunUseCaseError } = await import("@unprice/services/use-cases")
    useCaseMocks.startAgentRun.mockResolvedValue({
      val: undefined,
      err: new AgentRunUseCaseError("AGENT_NOT_FOUND"),
    })

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      new Request("https://example.com/v1/agents/agent_xyz/runs", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          customerId: "cus_123",
          currency: "usd",
          budgetAmount: 1000,
          idempotencyKey: "idem_1",
        }),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body).toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("applyAgentRunSyncEventV1", () => {
  it("returns 200 with sync decision", async () => {
    const decision = {
      allowed: true,
      state: "processed",
      budget: {
        runId: "run_1",
        status: "running",
        budgetAmount: 1000,
        consumedAmount: 100,
        remainingAmount: 900,
      },
    }

    useCaseMocks.applyAgentRunSyncEvent.mockResolvedValue({ val: decision, err: undefined })

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      new Request("https://example.com/v1/agents/agent_123/runs/run_1/events/sync", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          customerId: "cus_123",
          featureSlug: "tokens",
          idempotencyKey: "idem_evt_1",
          id: "evt_1",
          eventSlug: "token_usage",
          timestamp: 1700000000000,
          properties: { tokens: 100 },
        }),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual(decision)
  })

  it("returns 404 when run not found", async () => {
    const { AgentRunUseCaseError } = await import("@unprice/services/use-cases")
    useCaseMocks.applyAgentRunSyncEvent.mockResolvedValue({
      val: undefined,
      err: new AgentRunUseCaseError("RUN_NOT_FOUND"),
    })

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      new Request("https://example.com/v1/agents/agent_123/runs/run_1/events/sync", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          customerId: "cus_123",
          featureSlug: "tokens",
          idempotencyKey: "idem_evt_1",
          id: "evt_1",
          eventSlug: "token_usage",
          timestamp: 1700000000000,
          properties: { tokens: 100 },
        }),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body).toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("endAgentRunV1", () => {
  it("returns 200 with final budget summary", async () => {
    const budgetSummary = {
      runId: "run_1",
      status: "completed",
      budgetAmount: 1000,
      consumedAmount: 500,
      remainingAmount: 500,
    }

    useCaseMocks.endAgentRun.mockResolvedValue({ val: budgetSummary, err: undefined })

    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      new Request("https://example.com/v1/agents/agent_123/runs/run_1/end", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          customerId: "cus_123",
          status: "completed",
        }),
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual(budgetSummary)
  })
})

describe("getAgentRunV1", () => {
  it("returns 200 with budget summary when run exists", async () => {
    const budgetSummary = {
      runId: "run_1",
      status: "running",
      budgetAmount: 1000,
      consumedAmount: 200,
      remainingAmount: 800,
    }

    const getRunForAgent = vi.fn().mockResolvedValue({ id: "run_1" })
    runBudgetMocks.getRunStatus.mockResolvedValue(budgetSummary)

    const { app, env, executionCtx } = createTestApp({
      agents: {
        createAgent: vi.fn(),
        listAgents: vi.fn(),
        getActiveAgent: vi.fn(),
        getRunForAgent,
      },
    })

    const response = await app.fetch(
      new Request("https://example.com/v1/agents/agent_123/runs/run_1?customerId=cus_123", {
        method: "GET",
        headers: { authorization: "Bearer sk_test" },
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual(budgetSummary)
    expect(getRunForAgent).toHaveBeenCalledWith({
      agentId: "agent_123",
      customerId: "cus_123",
      projectId: "proj_123",
      runId: "run_1",
    })
  })

  it("returns 404 when run not found", async () => {
    const getRunForAgent = vi.fn().mockResolvedValue(null)
    const { app, env, executionCtx } = createTestApp({
      agents: {
        createAgent: vi.fn(),
        listAgents: vi.fn(),
        getActiveAgent: vi.fn(),
        getRunForAgent,
      },
    })

    const response = await app.fetch(
      new Request("https://example.com/v1/agents/agent_123/runs/run_xyz?customerId=cus_123", {
        method: "GET",
        headers: { authorization: "Bearer sk_test" },
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body).toMatchObject({ code: "NOT_FOUND" })
  })
})
