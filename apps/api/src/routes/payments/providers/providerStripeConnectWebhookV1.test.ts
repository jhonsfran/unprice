import { OpenAPIHono } from "@hono/zod-openapi"
import type { ExecutionContext } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { registerProviderStripeConnectWebhookV1 } from "./providerStripeConnectWebhookV1"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
  env: {
    NODE_ENV: "test",
  },
}))

const useCaseMocks = vi.hoisted(() => ({
  processWebhookEvent: vi.fn(),
}))

const providerMocks = vi.hoisted(() => ({
  verifyWebhook: vi.fn(),
}))

vi.mock("@unprice/services/use-cases", () => ({
  processWebhookEvent: useCaseMocks.processWebhookEvent,
}))

vi.mock("@unprice/services/payment-provider", () => ({
  StripePaymentProvider: vi.fn().mockImplementation(() => ({
    verifyWebhook: providerMocks.verifyWebhook,
  })),
}))

beforeEach(() => {
  providerMocks.verifyWebhook.mockResolvedValue({
    val: {
      eventId: "evt_1",
      eventType: "checkout.session.completed",
      occurredAt: 123,
      payload: {
        id: "evt_1",
        account: "acct_123",
        type: "checkout.session.completed",
      },
    },
  })

  useCaseMocks.processWebhookEvent.mockResolvedValue({
    val: {
      webhookEventId: "webhook_event_1",
      providerEventId: "evt_1",
      status: "processed",
      outcome: "payment_succeeded",
    },
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("providerStripeConnectWebhookV1 route", () => {
  it("maps the Connect account to the project and forwards the verified webhook", async () => {
    const { app, env, executionCtx } = createTestApp()
    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        received: true,
        webhookEventId: "webhook_event_1",
        providerEventId: "evt_1",
      })
    )

    expect(useCaseMocks.processWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: "proj_123",
        provider: "stripe",
        verifiedWebhook: expect.objectContaining({
          eventId: "evt_1",
        }),
        includeInactiveProvider: true,
      })
    )
  })

  it("processes settlement events for known disabled connected accounts", async () => {
    const { app, env, executionCtx } = createTestApp({
      paymentProviderConfig: {
        id: "ppc_123",
        projectId: "proj_123",
        paymentProvider: "stripe",
        connectionType: "managed_connection",
        externalAccountId: "acct_123",
        active: false,
      },
    })
    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(200)
    expect(useCaseMocks.processWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: "proj_123",
        includeInactiveProvider: true,
      })
    )
  })

  it("rejects unknown connected accounts", async () => {
    const { app, env, executionCtx } = createTestApp({ paymentProviderConfig: null })
    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "BAD_REQUEST",
      })
    )
    expect(useCaseMocks.processWebhookEvent).not.toHaveBeenCalled()
  })

  it("acks unsupported Connect event types without touching project state", async () => {
    providerMocks.verifyWebhook.mockResolvedValue({
      val: {
        eventId: "evt_customer_updated",
        eventType: "customer.updated",
        occurredAt: 123,
        payload: {
          id: "evt_customer_updated",
          account: "acct_123",
          type: "customer.updated",
        },
      },
    })

    const { app, env, executionCtx, paymentProviderConfigFindFirst } = createTestApp()
    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      received: true,
      providerEventId: "evt_customer_updated",
      status: "ignored",
      outcome: "ignored",
    })
    expect(paymentProviderConfigFindFirst).not.toHaveBeenCalled()
    expect(useCaseMocks.processWebhookEvent).not.toHaveBeenCalled()
  })

  it("accepts lifecycle events for known connected accounts without payment processing", async () => {
    providerMocks.verifyWebhook.mockResolvedValue({
      val: {
        eventId: "evt_account_updated",
        eventType: "account.updated",
        occurredAt: 123,
        payload: {
          id: "evt_account_updated",
          account: "acct_123",
          type: "account.updated",
        },
      },
    })

    const { app, env, executionCtx, paymentProviderConfigFindFirst } = createTestApp({
      paymentProviderConfig: {
        id: "ppc_123",
        projectId: "proj_123",
        paymentProvider: "stripe",
        connectionType: "managed_connection",
        externalAccountId: "acct_123",
        active: false,
      },
    })
    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      received: true,
      providerEventId: "evt_account_updated",
      status: "ignored",
      outcome: "ignored",
    })
    expect(paymentProviderConfigFindFirst).toHaveBeenCalled()
    expect(useCaseMocks.processWebhookEvent).not.toHaveBeenCalled()
  })
})

function createTestApp(opts?: { paymentProviderConfig?: Record<string, unknown> | null }) {
  const app = new OpenAPIHono<HonoEnv>()
  const paymentProviderConfigFindFirst = vi.fn().mockResolvedValue(
    opts?.paymentProviderConfig === null
      ? null
      : (opts?.paymentProviderConfig ?? {
          id: "ppc_123",
          projectId: "proj_123",
          paymentProvider: "stripe",
          connectionType: "managed_connection",
          externalAccountId: "acct_123",
          active: true,
        })
  )

  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }

    throw error
  })

  app.use("*", async (c, next) => {
    c.set("services", {
      customer: {},
      subscription: {},
      wallet: {},
      entitlement: {},
      plans: {},
      ingestion: {},
      project: {},
      apikey: {},
      ledger: {},
    })
    c.set("db", {
      query: {
        paymentProviderConfig: {
          findFirst: paymentProviderConfigFindFirst,
        },
      },
    })
    c.set("logger", {
      set: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })
    c.set("analytics", {})
    c.set("waitUntil", vi.fn())

    await next()
  })

  registerProviderStripeConnectWebhookV1(app)

  const env = {
    NODE_ENV: "production",
    STRIPE_API_KEY: "sk_test_platform",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect",
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx, paymentProviderConfigFindFirst }
}

function buildRequest() {
  return new Request("https://example.com/v1/payments/providers/stripe/connect/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=123,v1=fake",
    },
    body: JSON.stringify({
      id: "evt_1",
      account: "acct_123",
      type: "checkout.session.completed",
    }),
  })
}
