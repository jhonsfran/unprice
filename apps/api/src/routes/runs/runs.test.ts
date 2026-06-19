import { OpenAPIHono } from "@hono/zod-openapi"
import type { ExecutionContext } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

import { RunUseCaseError } from "@unprice/services/use-cases"
import { registerApplyRunSyncEventV1 } from "./applyRunSyncEventV1"
import { registerEndRunV1 } from "./endRunV1"
import { registerGetRunV1 } from "./getRunV1"
import { registerStartRunV1 } from "./startRunV1"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
  resolveCustomerIdForApiKey: vi.fn(),
}))

vi.mock("~/auth/key", () => ({
  keyAuth: authMocks.keyAuth,
  resolveContextProjectId: vi.fn((_c: unknown, projectId: string) => projectId),
  resolveCustomerIdForApiKey: authMocks.resolveCustomerIdForApiKey,
}))

// Mock the use cases
const useCaseMocks = vi.hoisted(() => ({
  startRun: vi.fn(),
  applyRunSyncEvent: vi.fn(),
  endRun: vi.fn(),
  getRun: vi.fn(),
}))

vi.mock("@unprice/services/use-cases", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    startRun: useCaseMocks.startRun,
    applyRunSyncEvent: useCaseMocks.applyRunSyncEvent,
    endRun: useCaseMocks.endRun,
    getRun: useCaseMocks.getRun,
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

// --- Verified key fixtures ---

/** API key with a default customer binding */
const verifiedKeyWithDefault = {
  id: "key_123",
  projectId: "proj_123",
  defaultCustomerId: "cus_default",
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

/** API key without a default customer (unbound) */
const verifiedKeyUnbound = {
  id: "key_456",
  projectId: "proj_123",
  defaultCustomerId: null,
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

/** API key bound to customer B (for cross-customer tests) */
const verifiedKeyBoundToB = {
  id: "key_789",
  projectId: "proj_123",
  defaultCustomerId: "cus_B",
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
  authMocks.keyAuth.mockResolvedValue(verifiedKeyWithDefault)
})

afterEach(() => {
  vi.clearAllMocks()
})

function createTestApp() {
  const app = new OpenAPIHono<HonoEnv>()

  const budgetRunsMock = {
    createRun: vi.fn(),
    getRun: vi.fn(),
    updateRunReservation: vi.fn(),
    updateRunSummary: vi.fn(),
  }

  const customerMock = {
    getActiveSubscription: vi.fn().mockResolvedValue({
      val: {
        activePhase: {
          planVersion: { currency: "USD" },
        },
      },
      err: undefined,
    }),
  }

  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }
    throw error
  })

  app.use("*", async (c, next) => {
    c.set("services", {
      budgetRuns: budgetRunsMock,
      customer: customerMock,
    } as unknown as HonoEnv["Variables"]["services"])
    await next()
  })

  registerStartRunV1(app)
  registerApplyRunSyncEventV1(app)
  registerEndRunV1(app)
  registerGetRunV1(app)

  const env = { APP_ENV: "development" }
  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx, budgetRunsMock, customerMock }
}

// ---------------------------------------------------------------------------
// Contract tests for the /v1/runs API surface
// ---------------------------------------------------------------------------

describe("budgeted runs API", () => {
  it("starts a run for the API key default customer without agent creation", async () => {
    // Given an API key with defaultCustomerId
    authMocks.keyAuth.mockResolvedValue(verifiedKeyWithDefault)
    authMocks.resolveCustomerIdForApiKey.mockReturnValue({
      success: true,
      customerId: "cus_default",
    })

    // Use case returns ledger-scale amounts (LEDGER_SCALE=8: $10.00 = 1_000_000_000)
    const runSummary = {
      runId: "brun_abc123",
      status: "running",
      customerId: "cus_default",
      budgetAmount: 1_000_000_000,
      consumedAmount: 0,
      remainingAmount: 1_000_000_000,
      currency: "USD",
      agentId: null,
    }

    useCaseMocks.startRun.mockResolvedValue({ val: runSummary, err: undefined })

    const { app, env, executionCtx } = createTestApp()

    // When POST /v1/runs is called without customerId (uses key default)
    const response = await app.fetch(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          budgetAmount: 1000,
          idempotencyKey: "idem_start_1",
          agentId: "my-agent",
        }),
      }),
      env,
      executionCtx
    )

    // Then response is 200, amounts are in currency minor units (cents)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      runId: expect.stringMatching(/^brun_/),
      status: "running",
      customerId: "cus_default",
      budgetAmount: 1000,
      consumedAmount: 0,
      remainingAmount: 1000,
      currency: "USD",
    })
  })

  it("rejects a mismatched customerId for a customer-bound API key", async () => {
    // Given an API key bound to customer A (cus_default)
    authMocks.keyAuth.mockResolvedValue(verifiedKeyWithDefault)
    authMocks.resolveCustomerIdForApiKey.mockReturnValue({
      success: false,
      code: "customer_forbidden",
      message: "API key is bound to a different customer",
    })

    const { app, env, executionCtx } = createTestApp()

    // When POST /v1/runs includes customer B
    const response = await app.fetch(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          customerId: "cus_other",
          budgetAmount: 1000,
          idempotencyKey: "idem_mismatch_1",
        }),
      }),
      env,
      executionCtx
    )

    // Then response is 403
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body).toMatchObject({ code: "FORBIDDEN" })
  })

  it("requires customerId for an unbound API key", async () => {
    // Given an API key without defaultCustomerId
    authMocks.keyAuth.mockResolvedValue(verifiedKeyUnbound)
    authMocks.resolveCustomerIdForApiKey.mockReturnValue({
      success: false,
      code: "customer_required",
      message: "customerId is required when API key has no default customer",
    })

    const { app, env, executionCtx } = createTestApp()

    // When POST /v1/runs omits customerId
    const response = await app.fetch(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          budgetAmount: 1000,
          idempotencyKey: "idem_unbound_1",
        }),
      }),
      env,
      executionCtx
    )

    // Then response is 400
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toMatchObject({ code: "BAD_REQUEST" })
  })

  it("applies sync usage without customerId or agentId in the request body", async () => {
    // Given a running budget run
    authMocks.keyAuth.mockResolvedValue(verifiedKeyWithDefault)

    const decision = {
      accepted: true,
      reason: "accepted",
      run: {
        runId: "brun_abc123",
        status: "running",
        customerId: "cus_default",
        budgetAmount: 1_000_000_000,
        consumedAmount: 100_000_000,
        remainingAmount: 900_000_000,
        currency: "USD",
        agentId: null,
      },
    }

    useCaseMocks.applyRunSyncEvent.mockResolvedValue({ val: decision, err: undefined })

    const { app, env, executionCtx } = createTestApp()

    // When POST /v1/runs/:runId/events/sync is called
    const response = await app.fetch(
      new Request("https://example.com/v1/runs/brun_abc123/events/sync", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          featureSlug: "tokens",
          idempotencyKey: "idem_sync_1",
          id: "evt_1",
          eventSlug: "token_usage",
          timestamp: 1700000000000,
          properties: { tokens: 100 },
        }),
      }),
      env,
      executionCtx
    )

    // Then the route resolves customer/project from the stored run and returns a decision
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      accepted: true,
      reason: "accepted",
      run: expect.objectContaining({
        runId: "brun_abc123",
        status: "running",
      }),
    })
  })

  it("does not allow a bound customer key to access another customer's run", async () => {
    // Given a run for customer A and a key bound to customer B
    authMocks.keyAuth.mockResolvedValue(verifiedKeyBoundToB)

    // The run belongs to customer A, but the key is bound to customer B.
    // The use case enforces customer scope and returns RUN_NOT_FOUND.
    useCaseMocks.getRun.mockResolvedValue({
      val: undefined,
      err: new RunUseCaseError("RUN_NOT_FOUND"),
    })

    const { app, env, executionCtx } = createTestApp()

    // When GET /v1/runs/:runId is called
    const response = await app.fetch(
      new Request("https://example.com/v1/runs/brun_abc123", {
        method: "GET",
        headers: { authorization: "Bearer sk_test" },
      }),
      env,
      executionCtx
    )

    // Then response is 404 or 403
    expect([403, 404]).toContain(response.status)
  })

  it("ends a run and releases the unused reservation", async () => {
    // Given a running budget run with unused budget
    authMocks.keyAuth.mockResolvedValue(verifiedKeyWithDefault)

    const finalSummary = {
      runId: "brun_abc123",
      status: "completed",
      customerId: "cus_default",
      budgetAmount: 1_000_000_000,
      consumedAmount: 300_000_000,
      remainingAmount: 700_000_000,
      currency: "USD",
      agentId: null,
    }

    useCaseMocks.endRun.mockResolvedValue({ val: finalSummary, err: undefined })

    const { app, env, executionCtx } = createTestApp()

    // When POST /v1/runs/:runId/end is called
    const response = await app.fetch(
      new Request("https://example.com/v1/runs/brun_abc123/end", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      env,
      executionCtx
    )

    // Then status is completed and remaining budget is not captured
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      runId: "brun_abc123",
      status: "completed",
      consumedAmount: 300,
      remainingAmount: 700,
    })
  })
})
