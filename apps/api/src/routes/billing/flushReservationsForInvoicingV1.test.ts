import { OpenAPIHono } from "@hono/zod-openapi"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
}))

vi.mock("~/auth/key", () => ({
  keyAuth: authMocks.keyAuth,
}))

const windowMocks = vi.hoisted(() => ({
  getEntitlementWindowStub: vi.fn(),
}))

vi.mock("~/ingestion/entitlements/client", () => ({
  CloudflareEntitlementWindowClient: class {
    public getEntitlementWindowStub = windowMocks.getEntitlementWindowStub
  },
}))

const runBudgetMocks = vi.hoisted(() => ({
  getByName: vi.fn(),
}))

import { registerFlushReservationsForInvoicingV1 } from "./flushReservationsForInvoicingV1"

const verifiedKey = {
  id: "key_123",
  projectId: "proj_123",
  project: {
    id: "proj_123",
    workspaceId: "ws_123",
    isInternal: false,
    isMain: false,
    workspace: { unPriceCustomerId: null },
  },
}

beforeEach(() => {
  authMocks.keyAuth.mockResolvedValue(verifiedKey)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("flushReservationsForInvoicingV1 route", () => {
  it("flushes reservation windows for an invoice statement", async () => {
    const flushSpy = vi.fn().mockResolvedValue({ ok: true, outcome: "flushed" })
    windowMocks.getEntitlementWindowStub.mockReturnValue({
      flushReservationForInvoicing: flushSpy,
    })

    const { app, env, executionCtx } = createTestApp({
      billingPeriods: [{ id: "bp_123" }],
      entitlements: [
        {
          id: "ce_123",
          subscriptionId: "sub_123",
          subscriptionPhaseId: "phase_123",
        },
      ],
    })

    const response = await app.fetch(
      buildRequest({
        customerId: "cus_123",
        subscriptionId: "sub_123",
        subscriptionPhaseId: "phase_123",
        statementKey: "stmt_123",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, flushed: 1, skipped: 0 })
    expect(flushSpy).toHaveBeenCalledWith({
      statementKey: "stmt_123",
      billingPeriodIds: ["bp_123"],
    })
  })

  it("returns 200 with skipped count when no entitlements match", async () => {
    const { app, env, executionCtx } = createTestApp({
      billingPeriods: [],
      entitlements: [],
    })

    const response = await app.fetch(
      buildRequest({
        customerId: "cus_123",
        subscriptionId: "sub_123",
        subscriptionPhaseId: "phase_123",
        statementKey: "stmt_123",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, flushed: 0, skipped: 0 })
  })

  it("throws 409 when flush is deferred", async () => {
    const flushSpy = vi
      .fn()
      .mockResolvedValue({ ok: false, outcome: "deferred", errorMessage: "pending" })
    windowMocks.getEntitlementWindowStub.mockReturnValue({
      flushReservationForInvoicing: flushSpy,
    })

    const { app, env, executionCtx } = createTestApp({
      billingPeriods: [{ id: "bp_123" }],
      entitlements: [{ id: "ce_123", subscriptionId: "sub_123", subscriptionPhaseId: "phase_123" }],
    })

    const response = await app.fetch(
      buildRequest({
        customerId: "cus_123",
        subscriptionId: "sub_123",
        subscriptionPhaseId: "phase_123",
        statementKey: "stmt_123",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(409)
  })

  it("throws 500 when flush reports wallet_error", async () => {
    const flushSpy = vi
      .fn()
      .mockResolvedValue({ ok: false, outcome: "wallet_error", errorMessage: "failed" })
    windowMocks.getEntitlementWindowStub.mockReturnValue({
      flushReservationForInvoicing: flushSpy,
    })

    const { app, env, executionCtx } = createTestApp({
      billingPeriods: [{ id: "bp_123" }],
      entitlements: [{ id: "ce_123", subscriptionId: "sub_123", subscriptionPhaseId: "phase_123" }],
    })

    const response = await app.fetch(
      buildRequest({
        customerId: "cus_123",
        subscriptionId: "sub_123",
        subscriptionPhaseId: "phase_123",
        statementKey: "stmt_123",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(500)
  })

  it("skips entitlements whose DO does not expose the flush RPC", async () => {
    windowMocks.getEntitlementWindowStub.mockReturnValue({
      // No flushReservationForInvoicing method
    })

    const { app, env, executionCtx } = createTestApp({
      billingPeriods: [{ id: "bp_123" }],
      entitlements: [{ id: "ce_123", subscriptionId: "sub_123", subscriptionPhaseId: "phase_123" }],
    })

    const response = await app.fetch(
      buildRequest({
        customerId: "cus_123",
        subscriptionId: "sub_123",
        subscriptionPhaseId: "phase_123",
        statementKey: "stmt_123",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, flushed: 0, skipped: 1 })
  })

  it("flushes matching run-budget captures before invoice materialization", async () => {
    const flushCapturesForInvoicing = vi
      .fn()
      .mockResolvedValue({ ok: true, flushed: 2, skipped: 0 })
    Object.defineProperty(flushCapturesForInvoicing, "call", {
      value: vi.fn(() => {
        throw new Error('Could not serialize object of type "DurableObject"')
      }),
    })
    runBudgetMocks.getByName.mockReturnValue({ flushCapturesForInvoicing })

    const { app, env, executionCtx } = createTestApp({
      billingPeriods: [{ cycleStartAt: 1_778_000_000_000, id: "bp_123" }],
      budgetRuns: [{ id: "brun_123" }],
      entitlements: [],
    })

    const response = await app.fetch(
      buildRequest({
        customerId: "cus_123",
        subscriptionId: "sub_123",
        subscriptionPhaseId: "phase_123",
        statementKey: "stmt_123",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, flushed: 2, skipped: 0 })
    expect(runBudgetMocks.getByName).toHaveBeenCalledWith("development:proj_123:cus_123:brun_123")
    expect(flushCapturesForInvoicing).toHaveBeenCalledWith({
      statementKey: "stmt_123",
      billingPeriodIds: ["bp_123"],
    })
  })
})

function createTestApp(options: {
  billingPeriods: Array<{ cycleStartAt?: number; id: string }>
  budgetRuns?: Array<{ id: string }>
  entitlements: Array<{ id: string; subscriptionId: string; subscriptionPhaseId: string }>
}) {
  const app = new OpenAPIHono<HonoEnv>()

  app.use(timing())

  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      const status =
        error.code === "CONFLICT"
          ? 409
          : error.code === "INTERNAL_SERVER_ERROR"
            ? 500
            : error.code === "RATE_LIMITED"
              ? 429
              : 400
      return c.json({ code: error.code, message: error.message }, status)
    }
    throw error
  })

  app.use("*", async (c, next) => {
    c.set("requestId", "req_123")
    c.set("requestStartedAt", Date.now())
    c.set("db", {
      query: {
        billingPeriods: {
          findMany: vi
            .fn()
            .mockResolvedValue(
              options.billingPeriods.map((period) => ({ cycleStartAt: 0, ...period }))
            ),
        },
        budgetRuns: {
          findMany: vi.fn().mockResolvedValue(options.budgetRuns ?? []),
        },
      },
    })
    c.set("services", {
      entitlement: {
        getCustomerEntitlementsForCustomer: vi.fn().mockResolvedValue({
          err: null,
          val: options.entitlements,
        }),
      },
    })
    await next()
  })

  registerFlushReservationsForInvoicingV1(app)

  const env = {
    APP_ENV: "development",
    entitlementwindow: {},
    runbudget: { getByName: runBudgetMocks.getByName },
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx }
}

function buildRequest(body: Record<string, unknown>) {
  return new Request("https://example.com/v1/internal/billing-reservations/flush-for-invoicing", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}
