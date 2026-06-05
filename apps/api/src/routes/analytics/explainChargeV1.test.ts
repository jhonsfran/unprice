import { OpenAPIHono } from "@hono/zod-openapi"
import { Ok } from "@unprice/error"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
}))

const useCaseMocks = vi.hoisted(() => ({
  explainCharge: vi.fn(),
}))

vi.mock("~/auth/key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/auth/key")>()
  return {
    ...actual,
    keyAuth: authMocks.keyAuth,
  }
})

vi.mock("@unprice/services/use-cases", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@unprice/services/use-cases")>()
  return {
    ...actual,
    explainCharge: useCaseMocks.explainCharge,
  }
})

import { registerExplainChargeV1 } from "./explainChargeV1"

const verifiedKey = {
  id: "key_123",
  projectId: "proj_123",
  project: {
    id: "proj_123",
    workspaceId: "ws_123",
    defaultCurrency: "USD",
    isInternal: false,
    isMain: false,
    workspace: {
      isMain: false,
      unPriceCustomerId: null,
    },
  },
}

beforeEach(() => {
  authMocks.keyAuth.mockResolvedValue(verifiedKey)
  useCaseMocks.explainCharge.mockResolvedValue(Ok(makeExplainChargeOutput()))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("explainChargeV1 route", () => {
  it("returns an explain charge response from the billing use case", async () => {
    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        invoice_id: "inv_1",
        entry_id: "entry_1",
        limit: 50,
        offset: 10,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      invoice: {
        id: "inv_1",
        statement_key: "stmt_1",
        customer_id: "cus_1",
        currency: "USD",
      },
      line: {
        entry_id: "entry_1",
        billing_period_id: "bp_1",
        kind: "subscription",
        amount: 425_000_000,
        currency: "USD",
      },
      scope: {
        project_id: "proj_123",
        customer_id: "cus_1",
        feature_slug: "tokens",
        period_key: "onetime:1700000000000",
        customer_entitlement_id: "ce_1",
        feature_plan_version_id: "fpv_1",
      },
      summary: {
        event_count: 1,
        total_usage: 100,
        total_amount: 425_000_000,
        latest_amount_after: 425_000_000,
        currency: "USD",
        amount_scale: 8,
        first_event_at: 1_700_000_000_000,
        last_event_at: 1_700_000_000_000,
        multi_component_event_count: 0,
      },
      events: [makeEvent()],
      answer: "deterministic answer",
      evidence: [
        { type: "ledger_line", id: "entry_1" },
        { type: "billing_period", id: "bp_1" },
      ],
      pagination: {
        limit: 50,
        offset: 10,
        has_more: false,
      },
    })
    expect(useCaseMocks.explainCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        db: expect.anything(),
        ledger: expect.anything(),
        analytics: expect.anything(),
      }),
      {
        projectId: "proj_123",
        invoiceId: "inv_1",
        entryId: "entry_1",
        limit: 50,
        offset: 10,
      }
    )
  })

  it("does not let a non-main key choose another project", async () => {
    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        invoice_id: "inv_other_project",
        entry_id: "entry_1",
        project_id: "proj_other",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "FORBIDDEN",
      })
    )
    expect(useCaseMocks.explainCharge).not.toHaveBeenCalled()
  })

  it("lets a main key select a project", async () => {
    authMocks.keyAuth.mockResolvedValueOnce({
      ...verifiedKey,
      projectId: "main_proj",
      project: {
        ...verifiedKey.project,
        id: "main_proj",
        isMain: true,
        workspace: {
          ...verifiedKey.project.workspace,
          isMain: true,
        },
      },
    })
    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        project_id: "proj_selected",
        invoice_id: "inv_1",
        entry_id: "entry_1",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    expect(useCaseMocks.explainCharge).toHaveBeenCalledWith(expect.anything(), {
      projectId: "proj_selected",
      invoiceId: "inv_1",
      entryId: "entry_1",
      limit: 100,
      offset: 0,
    })
  })
})

function createTestApp() {
  const app = new OpenAPIHono<HonoEnv>()

  app.use(timing())

  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }

    throw error
  })

  app.use("*", async (c, next) => {
    c.set("db", {})
    c.set("analytics", {})
    c.set("services", {
      ledger: {},
    })

    await next()
  })

  registerExplainChargeV1(app)

  const env = {
    APP_ENV: "development",
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx }
}

function buildRequest(body: Record<string, unknown>) {
  return new Request("https://example.com/v1/analytics/explain-charge", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function makeExplainChargeOutput() {
  return {
    invoice: {
      id: "inv_1",
      statementKey: "stmt_1",
      customerId: "cus_1",
      currency: "USD",
    },
    line: {
      entryId: "entry_1",
      billingPeriodId: "bp_1",
      kind: "subscription",
      amount: 425_000_000,
      currency: "USD",
    },
    scope: {
      projectId: "proj_123",
      customerId: "cus_1",
      featureSlug: "tokens",
      periodKey: "onetime:1700000000000",
      customerEntitlementId: "ce_1",
      featurePlanVersionId: "fpv_1",
    },
    summary: {
      eventCount: 1,
      totalUsage: 100,
      totalAmount: 425_000_000,
      latestAmountAfter: 425_000_000,
      currency: "USD",
      amountScale: 8,
      firstEventAt: 1_700_000_000_000,
      lastEventAt: 1_700_000_000_000,
      multiComponentEventCount: 0,
    },
    events: [makeEvent()],
    answer: "deterministic answer",
    evidence: [
      { type: "ledger_line" as const, id: "entry_1" },
      { type: "billing_period" as const, id: "bp_1" },
    ],
    pagination: {
      limit: 50,
      offset: 10,
      hasMore: false,
    },
  }
}

function makeEvent() {
  return {
    event_id: "evt_1",
    idempotency_key: "idem_1",
    customer_entitlement_id: "ce_1",
    grant_id: "grant_1",
    feature_plan_version_id: "fpv_1",
    feature_slug: "tokens",
    period_key: "onetime:1700000000000",
    event_slug: "tokens.used",
    aggregation_method: "sum",
    timestamp: 1_700_000_000_000,
    created_at: 1_700_000_000_100,
    delta: 100,
    value_after: 100,
    amount: 425_000_000,
    amount_after: 425_000_000,
    amount_scale: 8,
    currency: "USD",
    priced_at: 1_700_000_000_100,
    tier_index: 0,
    tier_mode: "graduated",
    pricing_component_count: 1,
    source_type: "api_key",
    source_id: "key_1",
  }
}
