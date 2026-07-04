import { OpenAPIHono } from "@hono/zod-openapi"
import { UnPriceCustomerError } from "@unprice/services/customers"
import type { ExecutionContext } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { registerCreatePaymentMethodV1 } from "./createPaymentMethodV1"
import { registerListPaymentMethodsV1 } from "./listPaymentMethodsV1"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
}))

vi.mock("~/auth/key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/auth/key")>()

  return {
    ...actual,
    keyAuth: authMocks.keyAuth,
  }
})

const verifiedKey = {
  id: "key_123",
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

const boundKey = {
  ...verifiedKey,
  defaultCustomerId: "cus_bound",
}

const customerRecord = {
  id: "cus_123",
  projectId: "proj_123",
  email: "customer@example.com",
  defaultCurrency: "USD",
}

beforeEach(() => {
  authMocks.keyAuth.mockResolvedValue(verifiedKey)
  vi.clearAllMocks()
})

describe("payment method routes", () => {
  it("lists payment methods only for customers in the API key project", async () => {
    const { app, env, executionCtx, customer } = createTestApp({
      customerResult: { err: undefined, val: customerRecord },
    })

    const response = await app.fetch(
      buildJsonRequest("https://example.com/v1/payment-methods/list", {
        customerId: "cus_123",
        provider: "sandbox",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual([])
    expect(customer.getCustomerByIdInProject).toHaveBeenCalledWith({
      id: "cus_123",
      projectId: "proj_123",
    })
    expect(customer.getPaymentMethods).toHaveBeenCalledWith({
      customerId: "cus_123",
      provider: "sandbox",
      projectId: "proj_123",
      opts: {},
    })
  })

  it("does not reveal payment methods for a customer outside the API key project", async () => {
    const { app, env, executionCtx, customer } = createTestApp({
      customerResult: { err: undefined, val: null },
    })

    const response = await app.fetch(
      buildJsonRequest("https://example.com/v1/payment-methods/list", {
        customerId: "cus_other",
        provider: "sandbox",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "NOT_FOUND",
      })
    )
    expect(customer.getCustomerByIdInProject).toHaveBeenCalledWith({
      id: "cus_other",
      projectId: "proj_123",
    })
    expect(customer.getPaymentMethods).not.toHaveBeenCalled()
  })

  it("rejects create payment method when a customer-bound key targets another customer", async () => {
    authMocks.keyAuth.mockResolvedValue(boundKey)
    const { app, env, executionCtx, customer } = createTestApp({
      customerResult: { err: undefined, val: customerRecord },
    })

    const response = await app.fetch(
      buildJsonRequest("https://example.com/v1/payment-methods/create", {
        customerId: "cus_other",
        paymentProvider: "sandbox",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
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
    expect(customer.getCustomerByIdInProject).not.toHaveBeenCalled()
    expect(customer.getPaymentProvider).not.toHaveBeenCalled()
  })

  it("creates payment method sessions only for customers in the API key project", async () => {
    const { app, env, executionCtx, customer, paymentProviderService } = createTestApp({
      customerResult: { err: undefined, val: customerRecord },
    })

    const response = await app.fetch(
      buildJsonRequest("https://example.com/v1/payment-methods/create", {
        customerId: "cus_123",
        paymentProvider: "sandbox",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      url: "https://example.com/setup",
    })
    expect(customer.getCustomerByIdInProject).toHaveBeenCalledWith({
      id: "cus_123",
      projectId: "proj_123",
    })
    expect(customer.getPaymentProvider).toHaveBeenCalledWith({
      customerId: "cus_123",
      projectId: "proj_123",
      provider: "sandbox",
    })
    expect(paymentProviderService.createSession).toHaveBeenCalledWith({
      customerId: "cus_123",
      projectId: "proj_123",
      email: "customer@example.com",
      currency: "USD",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    })
  })

  it("maps missing payment provider config to a precondition failure", async () => {
    const { app, env, executionCtx, customer, paymentProviderService } = createTestApp({
      customerResult: { err: undefined, val: customerRecord },
      paymentProviderResult: {
        err: new UnPriceCustomerError({
          code: "PAYMENT_PROVIDER_CONFIG_NOT_FOUND",
          message: "Payment provider config not found or not active",
        }),
        val: undefined,
      },
    })

    const response = await app.fetch(
      buildJsonRequest("https://example.com/v1/payment-methods/create", {
        customerId: "cus_123",
        paymentProvider: "stripe",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(412)
    await expect(response.json()).resolves.toEqual({
      code: "PRECONDITION_FAILED",
      message:
        "Billing portal is unavailable because Stripe is disabled or not configured for this billing project.",
    })
    expect(customer.getPaymentProvider).toHaveBeenCalledWith({
      customerId: "cus_123",
      projectId: "proj_123",
      provider: "stripe",
    })
    expect(paymentProviderService.createSession).not.toHaveBeenCalled()
  })
})

function createTestApp({
  customerResult,
  paymentProviderResult,
}: {
  customerResult: { err?: Error; val?: unknown }
  paymentProviderResult?: { err?: Error; val?: unknown }
}) {
  const app = new OpenAPIHono<HonoEnv>()
  const paymentProviderService = {
    createSession: vi.fn().mockResolvedValue({
      err: undefined,
      val: {
        success: true,
        url: "https://example.com/setup",
      },
    }),
  }
  const customer = {
    getCustomerByIdInProject: vi.fn().mockResolvedValue(customerResult),
    getPaymentMethods: vi.fn().mockResolvedValue({
      err: undefined,
      val: [],
    }),
    getPaymentProvider: vi.fn().mockResolvedValue(
      paymentProviderResult ?? {
        err: undefined,
        val: paymentProviderService,
      }
    ),
  }

  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }

    throw error
  })

  app.use("*", async (c, next) => {
    c.set("services", {
      customer,
    })

    await next()
  })

  registerListPaymentMethodsV1(app)
  registerCreatePaymentMethodV1(app)

  const env = {
    APP_ENV: "development",
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx, customer, paymentProviderService }
}

function buildJsonRequest(url: string, body: Record<string, unknown>) {
  return new Request(url, {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}
