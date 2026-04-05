import { OpenAPIHono } from "@hono/zod-openapi"
import { UnPriceCustomerError } from "@unprice/services/customers"
import type { ExecutionContext } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { registerStripeSignUpV1 } from "./stripeSignUpV1"

vi.mock("cloudflare:workers", () => ({
  env: {
    NODE_ENV: "test",
  },
}))

const useCaseMocks = vi.hoisted(() => ({
  completeStripeSignUp: vi.fn(),
}))

vi.mock("@unprice/services/use-cases", () => ({
  completeStripeSignUp: useCaseMocks.completeStripeSignUp,
}))

beforeEach(() => {
  useCaseMocks.completeStripeSignUp.mockResolvedValue({
    val: {
      redirectUrl: "https://example.com/success",
    },
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("stripeSignUpV1 route", () => {
  it("redirects to success url when use-case succeeds", async () => {
    const { app, env, executionCtx } = createTestApp()
    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("https://example.com/success")
  })

  it("maps CUSTOMER_SESSION_NOT_FOUND to NOT_FOUND", async () => {
    useCaseMocks.completeStripeSignUp.mockResolvedValue({
      err: new UnPriceCustomerError({
        code: "CUSTOMER_SESSION_NOT_FOUND",
        message: "Customer session not found",
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

  it("maps CUSTOMER_EXTERNAL_ID_CONFLICT to CONFLICT", async () => {
    useCaseMocks.completeStripeSignUp.mockResolvedValue({
      err: new UnPriceCustomerError({
        code: "CUSTOMER_EXTERNAL_ID_CONFLICT",
        message: "External customer id already exists for this project",
      }),
    })

    const { app, env, executionCtx } = createTestApp()
    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "CONFLICT",
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
    c.set("analytics", {
      ingestEvents: vi.fn(),
    })
    c.set("waitUntil", vi.fn())

    await next()
  })

  registerStripeSignUpV1(app)

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
  return new Request("https://example.com/v1/paymentProvider/stripe/signUp/sess_123/proj_123", {
    method: "GET",
    headers: {
      "x-forwarded-for": "127.0.0.1",
    },
  })
}
