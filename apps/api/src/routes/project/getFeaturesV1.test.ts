import { OpenAPIHono } from "@hono/zod-openapi"
import { FetchError } from "@unprice/error"
import { UnPriceProjectError } from "@unprice/services/projects"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { registerGetFeaturesV1 } from "./getFeaturesV1"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
}))

vi.mock("~/auth/key", () => ({
  keyAuth: authMocks.keyAuth,
}))

const verifiedKey = {
  id: "key_123",
  projectId: "proj_123",
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

beforeEach(() => {
  authMocks.keyAuth.mockResolvedValue(verifiedKey)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("getFeaturesV1 route", () => {
  it("returns features when project service resolves data", async () => {
    const { app, env, executionCtx, getProjectFeatures } = createTestApp({
      err: undefined,
      val: {
        project: { enabled: true },
        features: [{ id: "feat_1", slug: "tokens" }],
      },
    })

    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      features: [{ id: "feat_1", slug: "tokens" }],
    })
    expect(getProjectFeatures).toHaveBeenCalledWith({
      projectId: "proj_123",
    })
  })

  it("returns an empty list when project features are not found", async () => {
    const { app, env, executionCtx } = createTestApp({
      err: undefined,
      val: null,
    })

    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      features: [],
    })
  })

  it("maps PROJECT_NOT_ENABLED to FORBIDDEN", async () => {
    const { app, env, executionCtx } = createTestApp({
      err: new UnPriceProjectError({
        code: "PROJECT_NOT_ENABLED",
        message: "Project is not enabled",
      }),
      val: undefined,
    })

    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "FORBIDDEN",
      })
    )
  })

  it("maps unexpected service errors to INTERNAL_SERVER_ERROR", async () => {
    const { app, env, executionCtx } = createTestApp({
      err: new FetchError({
        message: "db failed",
        retry: false,
      }),
      val: undefined,
    })

    const response = await app.fetch(buildRequest(), env, executionCtx)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "INTERNAL_SERVER_ERROR",
      })
    )
  })
})

function createTestApp(
  result:
    | {
        err?: undefined
        val: {
          project: { enabled: boolean }
          features: Array<{ id: string; slug: string }>
        } | null
      }
    | {
        err: Error
        val?: undefined
      }
) {
  const app = new OpenAPIHono<HonoEnv>()
  const getProjectFeatures = vi.fn().mockResolvedValue(result)

  app.use(timing())

  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }

    throw error
  })

  app.use("*", async (c, next) => {
    c.set("services", {
      project: {
        getProjectFeatures,
      },
    })

    await next()
  })

  registerGetFeaturesV1(app)

  const env = {
    APP_ENV: "development",
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx, getProjectFeatures }
}

function buildRequest() {
  return new Request("https://example.com/v1/project/getFeatures", {
    method: "GET",
    headers: {
      authorization: "Bearer sk_test",
    },
  })
}
