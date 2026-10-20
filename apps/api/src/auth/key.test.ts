import { OpenAPIHono } from "@hono/zod-openapi"
import { DefaultStatefulContext, Namespace, createCache } from "@unkey/cache"
import { MemoryStore } from "@unkey/cache/stores"
import type { ApiKeyExtended, ApiKeyType } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import { ApiKeysService } from "@unprice/services/apikey"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import {
  isValidApiKeyShape,
  keyAuth,
  shouldBypassApiKeyRateLimit,
  validateIsAllowedToAccessProject,
} from "./key"

const asApiKey = (value: unknown) => value as ApiKeyExtended

const makeKey = (opts: { projectIsMain?: boolean | null; workspaceIsMain?: boolean }) =>
  asApiKey({
    projectId: "proj_key",
    project: {
      id: "proj_key",
      isMain: opts.projectIsMain ?? false,
      workspace: {
        isMain: opts.workspaceIsMain ?? false,
      },
    },
  })

const baseKey = makeKey({})

describe("validateIsAllowedToAccessProject", () => {
  it("uses key project when request does not provide a project", () => {
    const projectId = validateIsAllowedToAccessProject({
      key: baseKey,
      requestedProjectId: "",
    })

    expect(projectId).toBe("proj_key")
  })

  it("allows non-main keys to use their own project id", () => {
    const projectId = validateIsAllowedToAccessProject({
      key: baseKey,
      requestedProjectId: "proj_key",
    })

    expect(projectId).toBe("proj_key")
  })

  it("throws when non-main key requests another project", () => {
    expect(() =>
      validateIsAllowedToAccessProject({
        key: baseKey,
        requestedProjectId: "proj_other",
      })
    ).toThrowError(UnpriceApiError)
  })

  // Table-driven coverage of the canonical predicate: a key is "main" when either
  // the project OR its workspace is flagged main. This mirrors the eight routes that
  // now delegate the computation to the helper instead of passing their own boolean.
  const cases = [
    { name: "project.isMain", projectIsMain: true, workspaceIsMain: false, isMain: true },
    { name: "workspace.isMain", projectIsMain: false, workspaceIsMain: true, isMain: true },
    { name: "both main", projectIsMain: true, workspaceIsMain: true, isMain: true },
    { name: "neither main", projectIsMain: false, workspaceIsMain: false, isMain: false },
    { name: "null project.isMain", projectIsMain: null, workspaceIsMain: false, isMain: false },
  ] as const

  for (const testCase of cases) {
    it(`${testCase.name}: ${testCase.isMain ? "grants" : "denies"} cross-project access`, () => {
      const key = makeKey({
        projectIsMain: testCase.projectIsMain,
        workspaceIsMain: testCase.workspaceIsMain,
      })

      if (testCase.isMain) {
        expect(validateIsAllowedToAccessProject({ key, requestedProjectId: "proj_other" })).toBe(
          "proj_other"
        )
      } else {
        expect(() =>
          validateIsAllowedToAccessProject({ key, requestedProjectId: "proj_other" })
        ).toThrowError(UnpriceApiError)
      }
    })
  }
})

describe("isValidApiKeyShape", () => {
  it("accepts generated live key shape", () => {
    expect(isValidApiKeyShape("unprice_live_123456789ABCDEFGHJKLMN")).toBe(true)
  })

  it("accepts local dev keys only when explicitly allowed", () => {
    expect(isValidApiKeyShape("unprice_dev_1234567890")).toBe(false)
    expect(isValidApiKeyShape("unprice_dev_1234567890", { allowDevKey: true })).toBe(true)
  })

  it("rejects malformed and non-base58 keys", () => {
    expect(isValidApiKeyShape("sk_test_123")).toBe(false)
    expect(isValidApiKeyShape("unprice_live_123")).toBe(false)
    expect(isValidApiKeyShape("unprice_live_123456789ABCDEFGH0OIlM")).toBe(false)
  })
})

describe("shouldBypassApiKeyRateLimit", () => {
  it("bypasses rate limits for access check, including a trailing slash", () => {
    expect(shouldBypassApiKeyRateLimit("/v1/access/check")).toBe(true)
    expect(shouldBypassApiKeyRateLimit("/v1/access/check/")).toBe(true)
  })

  it("does not keep the old entitlement verify route as the bypass path", () => {
    expect(shouldBypassApiKeyRateLimit("/v1/entitlements/verify")).toBe(false)
  })
})

// A verified key as `verifyApiKey` returns it. `type` is left off deliberately in
// some cases to model rows created before the column existed and cache entries
// serialized before this deploy.
const verifiedKey = (type?: ApiKeyType) => ({
  id: "apikey_123",
  projectId: "proj_123",
  defaultCustomerId: null,
  ...(type ? { type } : {}),
  project: {
    id: "proj_123",
    workspaceId: "ws_123",
    isMain: false,
    isInternal: false,
    workspace: {
      unPriceCustomerId: "cus_unprice",
      isMain: false,
    },
  },
})

function createKeyAuthApp(opts: {
  key: ReturnType<typeof verifiedKey>
  requireType?: ApiKeyType | readonly ApiKeyType[]
}) {
  const app = new OpenAPIHono<HonoEnv>()
  const verifyApiKey = vi.fn().mockResolvedValue(Ok(opts.key as unknown as ApiKeyExtended))
  const loggerSet = vi.fn()

  app.use(timing())

  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }

    throw error
  })

  app.use("*", async (c, next) => {
    c.set("services", { apikey: { verifyApiKey } } as never)
    c.set("logger", { set: loggerSet, error: vi.fn() } as never)
    await next()
  })

  app.get("/v1/protected", async (c) => {
    const key = await keyAuth(c, opts.requireType ? { requireType: opts.requireType } : undefined)
    return c.json({ id: key.id, type: key.type })
  })

  const request = () =>
    app.fetch(
      new Request("https://example.com/v1/protected", {
        method: "GET",
        headers: { authorization: "Bearer unprice_live_123456789ABCDEFGHJKLMN" },
      }),
      // development skips key-shape and rate-limit checks
      { APP_ENV: "development" },
      { passThroughOnException: vi.fn(), waitUntil: vi.fn() } as unknown as ExecutionContext
    )

  return { request, loggerSet }
}

describe("keyAuth key type boundary", () => {
  it("accepts a runtime key on a route that does not ask for a type", async () => {
    const { request } = createKeyAuthApp({ key: verifiedKey("runtime") })

    const response = await request()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ id: "apikey_123", type: "runtime" })
  })

  it("accepts a config key when the route requires config", async () => {
    const { request } = createKeyAuthApp({
      key: verifiedKey("config"),
      requireType: "config",
    })

    const response = await request()

    expect(response.status).toBe(200)
  })

  it("rejects a runtime key on a config route with INSUFFICIENT_PERMISSIONS", async () => {
    const { request } = createKeyAuthApp({
      key: verifiedKey("runtime"),
      requireType: "config",
    })

    const response = await request()

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "INSUFFICIENT_PERMISSIONS" })
    )
  })

  it("rejects a config key on an existing runtime route with the same opaque failure", async () => {
    const runtimeOnConfig = await createKeyAuthApp({
      key: verifiedKey("runtime"),
      requireType: "config",
    }).request()
    const configOnRuntime = await createKeyAuthApp({ key: verifiedKey("config") }).request()

    expect(configOnRuntime.status).toBe(403)
    // the caller must not be able to tell which type it is missing
    await expect(configOnRuntime.json()).resolves.toEqual(await runtimeOnConfig.json())
  })

  it.each(["runtime", "config"] as const)(
    "accepts a %s key on a route that accepts both types",
    async (type) => {
      const { request } = createKeyAuthApp({
        key: verifiedKey(type),
        requireType: ["runtime", "config"],
      })

      const response = await request()

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ id: "apikey_123", type })
    }
  )

  it("treats a key row without a type as a runtime key", async () => {
    const { request } = createKeyAuthApp({ key: verifiedKey() })

    const response = await request()

    expect(response.status).toBe(200)
  })

  it("does not let an untyped key reach a config route", async () => {
    const { request } = createKeyAuthApp({ key: verifiedKey(), requireType: "config" })

    const response = await request()

    expect(response.status).toBe(403)
  })

  it("records the key id and resolved type in business context", async () => {
    const { request, loggerSet } = createKeyAuthApp({ key: verifiedKey("config") })

    await request()

    expect(loggerSet).toHaveBeenCalledWith(
      expect.objectContaining({
        business: expect.objectContaining({
          api_key_id: "apikey_123",
          api_key_type: "config",
        }),
      })
    )
  })

  it("resolves an untyped cached key to runtime for downstream callers", async () => {
    const { request } = createKeyAuthApp({ key: verifiedKey() })

    // the returned key is what routes and resolveOwnedCustomer consume, so the deploy-window
    // gap has to be closed here rather than re-derived at every call site
    await expect(request().then((response) => response.json())).resolves.toEqual({
      id: "apikey_123",
      type: "runtime",
    })
  })

  it("tags the opaque rejection so operators can tell it apart from other 403s", async () => {
    const { request, loggerSet } = createKeyAuthApp({
      key: verifiedKey("runtime"),
      requireType: "config",
    })

    await request()

    expect(loggerSet).toHaveBeenCalledWith({ error: { type: "INSUFFICIENT_PERMISSIONS" } })
  })
})

describe("keyAuth with an unknown key", () => {
  // Production reads go to the read replicas (`withReplicas`). A replica that fails must not turn
  // "this key does not exist" into a 500: the lookup retries on the primary, which answers no row.
  function createUnknownKeyApp(opts: {
    replica: () => Promise<unknown>
    primary: () => Promise<unknown>
  }) {
    const replicaFindFirst = vi.fn(opts.replica)
    const primaryFindFirst = vi.fn(opts.primary)
    const ctx = new DefaultStatefulContext()
    const cache = createCache({
      apiKeyByHash: new Namespace(ctx, {
        stores: [new MemoryStore({ persistentMap: new Map() })],
        fresh: 60_000,
        stale: 86_400_000,
      }),
    })
    const logger = { set: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const apikey = new ApiKeysService({
      cache: cache as never,
      metrics: { emit: vi.fn() } as never,
      analytics: {} as never,
      logger: logger as never,
      db: {
        query: { apikeys: { findFirst: replicaFindFirst } },
        $primary: { query: { apikeys: { findFirst: primaryFindFirst } } },
      } as never,
      waitUntil: vi.fn(),
      hashCache: new Map(),
    })

    const app = new OpenAPIHono<HonoEnv>()
    app.use(timing())
    app.onError((error, c) => {
      if (error instanceof UnpriceApiError) {
        return c.json({ code: error.code, message: error.message }, error.status)
      }
      throw error
    })
    app.use("*", async (c, next) => {
      c.set("services", { apikey } as never)
      c.set("logger", logger as never)
      await next()
    })
    app.post("/v1/budgets/authorize", async (c) => {
      await keyAuth(c)
      return c.json({ ok: true })
    })

    const request = () =>
      app.fetch(
        new Request("https://api.unprice.dev/v1/budgets/authorize", {
          method: "POST",
          // well-formed, so it passes the production shape check and reaches the lookup
          headers: { authorization: "Bearer unprice_live_5555555555555555555555" },
        }),
        { APP_ENV: "production" },
        { passThroughOnException: vi.fn(), waitUntil: vi.fn() } as unknown as ExecutionContext
      )

    return { request, replicaFindFirst, primaryFindFirst }
  }

  it("answers 401 when the key has no row", async () => {
    const { request, primaryFindFirst } = createUnknownKeyApp({
      replica: async () => undefined,
      primary: async () => undefined,
    })

    const response = await request()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "key not found",
    })
    expect(primaryFindFirst).not.toHaveBeenCalled()
  })

  it("answers 401, not 500, when the replica lookup fails and the primary has no row", async () => {
    const { request, replicaFindFirst, primaryFindFirst } = createUnknownKeyApp({
      replica: async () => {
        throw new Error("replica unavailable")
      },
      primary: async () => undefined,
    })

    const response = await request()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "key not found",
    })
    expect(replicaFindFirst).toHaveBeenCalledOnce()
    expect(primaryFindFirst).toHaveBeenCalledOnce()
  })

  it("still answers 500 when the primary fails too", async () => {
    const { request } = createUnknownKeyApp({
      replica: async () => {
        throw new Error("replica unavailable")
      },
      primary: async () => {
        throw new Error("primary unavailable")
      },
    })

    const response = await request()

    expect(response.status).toBe(500)
  })
})
