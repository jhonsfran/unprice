import { OpenAPIHono } from "@hono/zod-openapi"
import type { ExecutionContext } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { registerUpdateACLV1 } from "./updateACLV1"

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
      isMain: false,
      unPriceCustomerId: null,
    },
  },
}

const boundKey = {
  ...verifiedKey,
  defaultCustomerId: "cus_bound",
}

beforeEach(() => {
  authMocks.keyAuth.mockResolvedValue(verifiedKey)
  vi.clearAllMocks()
})

describe("updateACLV1 route", () => {
  it("updates the ACL for a customer in the API key project", async () => {
    const { app, env, executionCtx, customer } = createTestApp({
      customerResult: {
        err: undefined,
        val: {
          id: "cus_123",
          projectId: "proj_123",
        },
      },
    })

    const response = await app.fetch(
      buildRequest({
        customerId: "cus_123",
        updates: {
          customerDisabled: true,
        },
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({})
    expect(customer.getCustomerByIdInProject).toHaveBeenCalledWith({
      id: "cus_123",
      projectId: "proj_123",
    })
    expect(customer.updateAccessControlList).toHaveBeenCalledWith({
      customerId: "cus_123",
      projectId: "proj_123",
      updates: {
        customerDisabled: true,
      },
    })
  })

  it("rejects customer-bound keys that target another customer", async () => {
    authMocks.keyAuth.mockResolvedValue(boundKey)
    const { app, env, executionCtx, customer } = createTestApp({
      customerResult: {
        err: undefined,
        val: {
          id: "cus_other",
          projectId: "proj_123",
        },
      },
    })

    const response = await app.fetch(
      buildRequest({
        customerId: "cus_other",
        updates: {
          customerDisabled: true,
        },
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
    expect(customer.updateAccessControlList).not.toHaveBeenCalled()
  })

  it("returns not found when the customer is outside the API key project", async () => {
    const { app, env, executionCtx, customer } = createTestApp({
      customerResult: {
        err: undefined,
        val: null,
      },
    })

    const response = await app.fetch(
      buildRequest({
        customerId: "cus_other",
        updates: {
          customerDisabled: true,
        },
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
    expect(customer.updateAccessControlList).not.toHaveBeenCalled()
  })
})

function createTestApp({
  customerResult,
}: {
  customerResult: { err?: Error; val?: unknown }
}) {
  const app = new OpenAPIHono<HonoEnv>()
  const customer = {
    getCustomerByIdAcrossProjects: vi.fn().mockResolvedValue(customerResult),
    getCustomerByIdInProject: vi.fn().mockResolvedValue(customerResult),
    updateAccessControlList: vi.fn().mockResolvedValue(undefined),
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

  registerUpdateACLV1(app)

  const env = {
    APP_ENV: "development",
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx, customer }
}

function buildRequest(body: Record<string, unknown>) {
  return new Request("https://example.com/v1/access/update", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}
