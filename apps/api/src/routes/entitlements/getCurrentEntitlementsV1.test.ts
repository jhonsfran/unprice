import { OpenAPIHono } from "@hono/zod-openapi"
import { Err } from "@unprice/error"
import { UnPriceCustomerError } from "@unprice/services/customers"
import type * as UseCasesModule from "@unprice/services/use-cases"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
}))

const useCaseMocks = vi.hoisted(() => ({
  getCustomerCurrentEntitlements: vi.fn(),
}))

vi.mock("~/auth/key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/auth/key")>()
  return { ...actual, keyAuth: authMocks.keyAuth }
})

vi.mock("@unprice/services/use-cases", async (importOriginal) => {
  const actual = await importOriginal<typeof UseCasesModule>()
  return {
    ...actual,
    getCustomerCurrentEntitlements: useCaseMocks.getCustomerCurrentEntitlements,
  }
})

import { registerGetCurrentEntitlementsV1 } from "./getCurrentEntitlementsV1"

const now = Date.UTC(2026, 7, 28, 10, 0, 0)
const verifiedKey = {
  id: "key_123",
  projectId: "proj_123",
  defaultCustomerId: null,
  project: {
    id: "proj_123",
    workspaceId: "ws_123",
    defaultCurrency: "USD",
    isInternal: false,
    isMain: false,
    workspace: { isMain: false, unPriceCustomerId: null },
  },
}

beforeEach(() => {
  authMocks.keyAuth.mockResolvedValue(verifiedKey)
  useCaseMocks.getCustomerCurrentEntitlements.mockResolvedValue({
    val: {
      customerId: "cus_123",
      generatedAt: now,
      entitlements: [
        {
          id: "ce_tokens",
          featureSlug: "tokens",
          featureTitle: "Total tokens",
          featureType: "usage",
          unitOfMeasure: "token",
          grantCount: 1,
          status: "available",
          allowed: true,
          limit: null,
          usage: 1_400,
          usagePercent: null,
          quotaWindow: null,
          spending: {
            currency: "USD",
            displayAmount: "$3.25",
            ledgerAmount: 325_000_000,
            scale: 8,
          },
        },
      ],
    },
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("getCurrentEntitlementsV1 route", () => {
  it("returns the current entitlement snapshot", async () => {
    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        customerId: "cus_123",
        generatedAt: now,
        entitlements: [expect.objectContaining({ id: "ce_tokens", usage: 1_400 })],
      })
    )
    expect(useCaseMocks.getCustomerCurrentEntitlements).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlementWindowClient: expect.any(Object),
        entitlements: expect.any(Object),
      }),
      { customerId: "cus_123", projectId: "proj_123" }
    )
  })

  it("maps an expected domain error to the public error response", async () => {
    useCaseMocks.getCustomerCurrentEntitlements.mockResolvedValue(
      Err(new UnPriceCustomerError({ code: "CUSTOMER_NOT_FOUND", message: "Customer not found" }))
    )
    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Customer not found",
        docs: "https://docs.unprice.dev/api-reference/errors/code/BAD_REQUEST",
        requestId: "req_123",
      },
    })
  })

  it("rejects another project for a non-main key before calling the use case", async () => {
    const { app, env, executionCtx } = createTestApp()

    const response = await app.fetch(buildRequest("proj_other"), env, executionCtx)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "You are not allowed to access a different project.",
        docs: "https://docs.unprice.dev/api-reference/errors/code/FORBIDDEN",
        requestId: "req_123",
      },
    })
    expect(useCaseMocks.getCustomerCurrentEntitlements).not.toHaveBeenCalled()
  })
})

function createTestApp() {
  const app = new OpenAPIHono<HonoEnv>()

  app.onError(handleError)
  app.use(timing())
  app.use("*", async (c, next) => {
    c.set("requestId", "req_123")
    c.set("services", { entitlement: {} })
    c.set("logger", {
      set: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    })
    c.set("requestStartedAt", now)
    await next()
  })

  registerGetCurrentEntitlementsV1(app)

  return {
    app,
    env: {
      APP_ENV: "development",
      entitlementwindow: {},
    },
    executionCtx: {
      passThroughOnException: vi.fn(),
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext,
  }
}

function buildRequest(projectId?: string) {
  return new Request("https://example.com/v1/access/entitlements/current", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ customerId: "cus_123", projectId }),
  })
}
