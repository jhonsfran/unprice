import { OpenAPIHono } from "@hono/zod-openapi"
import { UnPriceCustomerError } from "@unprice/services/customers"
import type { ExecutionContext } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { registerProviderWebhookV1 } from "./providerWebhookV1"

vi.mock("cloudflare:workers", () => ({
  env: {
    NODE_ENV: "test",
  },
}))

const useCaseMocks = vi.hoisted(() => ({
  processWebhookEvent: vi.fn(),
}))

vi.mock("@unprice/services/use-cases", () => ({
  processWebhookEvent: useCaseMocks.processWebhookEvent,
}))

beforeEach(() => {
  useCaseMocks.processWebhookEvent.mockResolvedValue({
    val: {
      webhookEventId: "webhook_event_1",
      providerEventId: "evt_1",
      status: "processed",
      outcome: "payment_succeeded",
      invoiceId: "inv_1",
      subscriptionId: "sub_1",
    },
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("providerWebhookV1 route", () => {
  it("processes webhook and returns normalized processing output", async () => {
    const { app, env, executionCtx } = createTestApp()
    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        received: true,
        webhookEventId: "webhook_event_1",
        providerEventId: "evt_1",
        status: "processed",
        outcome: "payment_succeeded",
      })
    )
    expect(useCaseMocks.processWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it("maps PAYMENT_PROVIDER_ERROR to BAD_REQUEST", async () => {
    useCaseMocks.processWebhookEvent.mockResolvedValue({
      err: new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: "Missing webhook signature",
      }),
    })

    const { app, env, executionCtx } = createTestApp()
    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "BAD_REQUEST",
      })
    )
  })

  it("returns duplicate status for already processed provider events", async () => {
    useCaseMocks.processWebhookEvent.mockResolvedValue({
      val: {
        webhookEventId: "webhook_event_1",
        providerEventId: "evt_1",
        status: "duplicate",
        outcome: "ignored",
      },
    })

    const { app, env, executionCtx } = createTestApp()
    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        status: "duplicate",
      })
    )
  })
})

function createTestApp() {
  const app = new OpenAPIHono<HonoEnv>()

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
    })
    c.set("db", {})
    c.set("logger", {
      set: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })

    await next()
  })

  registerProviderWebhookV1(app)

  const env = {
    NODE_ENV: "production",
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx }
}

function buildRequest() {
  return new Request("https://example.com/v1/paymentProvider/stripe/webhook/proj_123", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=123,v1=fake",
    },
    body: JSON.stringify({
      id: "evt_1",
      type: "invoice.paid",
    }),
  })
}
