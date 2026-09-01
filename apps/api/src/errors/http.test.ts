import { OpenAPIHono } from "@hono/zod-openapi"
import { BaseError, FetchError, SchemaError } from "@unprice/error"
import { UnPriceBillingError } from "@unprice/services/billing"
import { UnPriceCustomerError } from "@unprice/services/customers"
import { UnPriceMachineError, UnPriceSubscriptionError } from "@unprice/services/subscriptions"
import { HTTPException } from "hono/http-exception"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { HonoEnv } from "~/hono/env"
import { UnpriceApiError, handleError } from "./http"

const requestId = "req_test_123"

class UnknownDomainError extends BaseError {
  public readonly retry = false
  public readonly name = UnknownDomainError.name
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("handleError", () => {
  it("returns generic messages for UnpriceApiError 5xx responses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await fetchErrorResponse(
      new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "database password leaked in stack context",
      })
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        docs: "https://docs.unprice.dev/api-reference/errors/code/INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        requestId,
      },
    })
  })

  it("keeps expected 4xx messages specific", async () => {
    const response = await fetchErrorResponse(
      new UnpriceApiError({
        code: "BAD_REQUEST",
        message: "Invalid customer id",
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "BAD_REQUEST",
        docs: "https://docs.unprice.dev/api-reference/errors/code/BAD_REQUEST",
        message: "Invalid customer id",
        requestId,
      },
    })
  })

  it("returns generic messages for HTTPException 5xx responses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await fetchErrorResponse(
      new HTTPException(502, { message: "upstream secret token rejected" })
    )

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        docs: "https://docs.unprice.dev/api-reference/errors/code/INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        requestId,
      },
    })
  })

  it("returns generic messages for infrastructure errors", async () => {
    const response = await fetchErrorResponse(
      new FetchError({
        message: "database connection string rejected",
        retry: false,
      })
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        requestId,
      },
    })
  })

  // A 5XX message is replaced with a generic one, so its structured detail has to
  // go with it — otherwise the detail becomes the leak the message replacement
  // prevents. These two run as a pair on purpose: the 5XX case alone would pass
  // just as well if `details` were never emitted at all, so the 4XX case is the
  // control that proves the field does propagate and only the guard suppresses it.
  it("drops structured details from 5xx responses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await fetchErrorResponse(
      new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "planVersionFeatures.configHash violates not-null",
        details: {
          kind: "invalid_config",
          issues: [{ path: "config.plans[0].slug", message: "internal detail" }],
        },
      })
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        docs: "https://docs.unprice.dev/api-reference/errors/code/INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        requestId,
      },
    })
  })

  it("keeps structured details on 4xx responses", async () => {
    const response = await fetchErrorResponse(
      new UnpriceApiError({
        code: "BAD_REQUEST",
        message: "The monetization configuration document is not valid",
        details: {
          kind: "invalid_config",
          issues: [{ path: "config.plans[0].slug", message: "Required" }],
        },
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "BAD_REQUEST",
        docs: "https://docs.unprice.dev/api-reference/errors/code/BAD_REQUEST",
        message: "The monetization configuration document is not valid",
        requestId,
        details: {
          kind: "invalid_config",
          issues: [{ path: "config.plans[0].slug", message: "Required" }],
        },
      },
    })
  })

  it("returns generic messages for unhandled errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await fetchErrorResponse(new Error("raw internal failure details"))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        requestId,
      },
    })
  })

  it.each([
    {
      name: "disabled customer",
      error: new UnPriceCustomerError({
        code: "CUSTOMER_DISABLED",
        message: "customer is disabled",
      }),
      status: 403,
      code: "FORBIDDEN",
      message: "customer is disabled",
    },
    {
      name: "customer precondition",
      error: new UnPriceCustomerError({
        code: "SUBSCRIPTION_NOT_ACTIVE",
        message: "subscription is not active",
      }),
      status: 412,
      code: "PRECONDITION_FAILED",
      message: "subscription is not active",
    },
    {
      name: "subscription conflict",
      error: new UnPriceSubscriptionError({
        code: "SUBSCRIPTION_ALREADY_EXISTS",
        message: "subscription already exists",
      }),
      status: 409,
      code: "CONFLICT",
      message: "subscription already exists",
    },
    {
      name: "explicit not-found domain error",
      error: new UnPriceMachineError({
        kind: "not_found",
        message: "resource not found",
      }),
      status: 404,
      code: "NOT_FOUND",
      message: "resource not found",
    },
    {
      name: "schema error",
      error: new SchemaError({ message: "invalid shape" }),
      status: 400,
      code: "BAD_REQUEST",
      message: "invalid shape",
    },
  ])("maps $name through the domain error registry", async ({ error, status, code, message }) => {
    const response = await fetchErrorResponse(error)

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toMatchObject({
      error: { code, message, requestId },
    })
  })

  it.each([
    new UnPriceBillingError({
      code: "BILLING_OPERATION_FAILED",
      message: "database write failed",
    }),
    new UnknownDomainError({ message: "unregistered domain failure" }),
  ])("keeps internal and unregistered domain errors private", async (error) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await fetchErrorResponse(error)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        requestId,
      },
    })
  })
})

async function fetchErrorResponse(error: Error): Promise<Response> {
  const app = new OpenAPIHono<HonoEnv>()

  app.use("*", async (c, next) => {
    c.set("requestId", requestId)
    await next()
  })

  app.get("/boom", () => {
    throw error
  })

  app.onError(handleError)

  return app.request("/boom")
}
