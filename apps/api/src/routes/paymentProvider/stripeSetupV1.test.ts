import { OpenAPIHono } from "@hono/zod-openapi"
import { UnPriceCustomerError } from "@unprice/services/customers"
import type { ExecutionContext } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { registerStripeSetupV1 } from "./stripeSetupV1"

vi.mock("cloudflare:workers", () => ({
  env: {
    NODE_ENV: "test",
  },
}))

const useCaseMocks = vi.hoisted(() => ({
  completeStripeSetup: vi.fn(),
}))

vi.mock("@unprice/services/use-cases", () => ({
  completeStripeSetup: useCaseMocks.completeStripeSetup,
}))

beforeEach(() => {
  useCaseMocks.completeStripeSetup.mockResolvedValue({
    val: {
      redirectUrl: "https://example.com/success",
    },
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("stripeSetupV1 route", () => {
  it("redirects to success url when use-case succeeds", async () => {
    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("https://example.com/success")
  })

  it("maps CUSTOMER_NOT_FOUND to NOT_FOUND", async () => {
    useCaseMocks.completeStripeSetup.mockResolvedValue({
      err: new UnPriceCustomerError({
        code: "CUSTOMER_NOT_FOUND",
        message: "Unprice customer not found in database",
      }),
    })

    const { app, env, executionCtx } = createTestApp()
    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "NOT_FOUND",
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

  registerStripeSetupV1(app)

  const env = {
    NODE_ENV: "production",
    RL_FREE_1000_60s: {
      limit: vi.fn().mockResolvedValue(true),
    },
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx }
}

function buildRequest() {
  return new Request("https://example.com/v1/paymentProvider/stripe/setup/sess_123/proj_123", {
    method: "GET",
    headers: {
      "x-forwarded-for": "127.0.0.1",
    },
  })
}
