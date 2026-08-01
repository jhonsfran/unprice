import { OpenAPIHono } from "@hono/zod-openapi"
import { APP_DOMAIN } from "@unprice/config"
import type { ApiKeyType, MonetizationConfigInput } from "@unprice/db/validators"
import { FetchError, Ok } from "@unprice/error"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { registerIngestEventsSyncV1 } from "~/routes/events/ingestEventsSyncV1"
import { route as applyRoute, registerApplyMonetizationV1 } from "./applyMonetizationV1"
import { route as getRoute, registerGetMonetizationV1 } from "./getMonetizationV1"

const useCaseMocks = vi.hoisted(() => ({
  applyMonetizationConfig: vi.fn(),
  getMonetizationConfig: vi.fn(),
}))

vi.mock("@unprice/services/use-cases", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@unprice/services/use-cases")>()

  return {
    ...actual,
    applyMonetizationConfig: useCaseMocks.applyMonetizationConfig,
    getMonetizationConfig: useCaseMocks.getMonetizationConfig,
  }
})

const INTEGRATION_CONTRACT = {
  defaultPlan: { slug: "free", planVersionId: "pv_free", note: "default" },
  events: [],
  features: [],
  warnings: [],
}

/** A valid `usage.consume` payload; that route is only used to prove the key boundary. */
const consumeBody = {
  idempotencyKey: "idem_1",
  eventSlug: "chat_request",
  featureSlug: "chat-messages",
  customerId: "cus_test",
  properties: {},
}

function validConfig(): MonetizationConfigInput {
  return {
    events: [{ slug: "chat_request", name: "Chat request" }],
    features: [{ slug: "support", title: "Support", unitOfMeasure: "access" }],
    plans: [
      {
        slug: "free",
        title: "Free",
        defaultPlan: true,
        version: {
          currency: "USD",
          paymentProvider: "stripe",
          paymentMethodRequired: false,
          billingConfig: { name: "monthly", interval: "month", intervalCount: 1 },
          features: [{ featureSlug: "support", featureType: "flat", config: { price: "0.00" } }],
        },
      },
    ],
  }
}

/**
 * A verified key exactly as `verifyApiKey` returns it. `workspaceSlug: null`
 * models a cache entry serialized before `workspace.slug` was selected — plain
 * JSON, never re-parsed, servable for the full 24h stale window after a deploy.
 */
function verifiedKey(type: ApiKeyType, workspaceSlug: string | null = "acme-workspace") {
  return {
    id: "apikey_123",
    projectId: "proj_123",
    defaultCustomerId: null,
    type,
    project: {
      id: "proj_123",
      slug: "acme-api",
      workspaceId: "ws_123",
      isMain: false,
      isInternal: false,
      defaultCurrency: "USD",
      workspace: {
        ...(workspaceSlug === null ? {} : { slug: workspaceSlug }),
        unPriceCustomerId: "cus_unprice",
        enabled: true,
        isMain: false,
      },
    },
  }
}

type Harness = {
  fetch: (input: { path: string; method: "GET" | "POST"; body?: unknown }) => Promise<Response>
}

function createHarness(
  opts: {
    keyType?: ApiKeyType
    workspaceSlug?: string | null
  } = {}
): Harness {
  const app = new OpenAPIHono<HonoEnv>()

  const verifyApiKey = vi
    .fn()
    .mockResolvedValue(
      Ok(
        verifiedKey(
          opts.keyType ?? "config",
          opts.workspaceSlug === undefined ? "acme-workspace" : opts.workspaceSlug
        )
      )
    )

  app.use(timing())
  app.onError(handleError)

  app.use("*", async (c, next) => {
    c.set("requestId", "req_test")
    c.set("requestStartedAt", Date.now())
    c.set("logger", { set: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never)
    c.set("db", {} as never)
    c.set("services", {
      apikey: { verifyApiKey },
      plans: {},
      features: {},
      events: {},
      ingestion: {
        ingestFeatureSync: vi.fn().mockResolvedValue({
          allowed: true,
          state: "processed",
          idempotencyStatus: "new",
        }),
      },
    } as never)

    await next()
  })

  registerApplyMonetizationV1(app)
  registerGetMonetizationV1(app)
  registerIngestEventsSyncV1(app)

  return {
    fetch: ({ path, method, body }) =>
      app.fetch(
        new Request(`https://api.example.com${path}`, {
          method,
          headers: {
            authorization: "Bearer unprice_live_123456789ABCDEFGHJKLMN",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        // development skips the key-shape check and the rate limiter
        { APP_ENV: "development" },
        { passThroughOnException: vi.fn(), waitUntil: vi.fn() } as unknown as ExecutionContext
      ),
  }
}

const applyOk = (
  plans: Array<{
    slug: string
    planVersionId: string
    status: "created" | "unchanged" | "published"
  }>,
  staleDrafts: Array<{ slug: string; planVersionId: string }> = []
) =>
  Ok({
    state: "ok" as const,
    plans,
    staleDrafts,
    integrationContract: INTEGRATION_CONTRACT,
  })

beforeEach(() => {
  useCaseMocks.applyMonetizationConfig.mockResolvedValue(
    applyOk([{ slug: "free", planVersionId: "pv_1", status: "created" }])
  )
  useCaseMocks.getMonetizationConfig.mockResolvedValue(
    Ok({
      state: "ok" as const,
      config: validConfig(),
      plans: [{ slug: "free", publishedVersionId: null, draftVersionIds: ["pv_1"] }],
      unrepresentablePlans: [],
      warnings: [],
      integrationContract: INTEGRATION_CONTRACT,
    })
  )
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("monetization route contracts", () => {
  it("registers exactly the two intended operations", () => {
    const routes = [applyRoute, getRoute].map((route) => ({
      operationId: route.operationId,
      method: route.method,
      path: route.path,
    }))

    expect(routes).toMatchObject([
      { operationId: "monetization.apply", method: "post", path: "/v1/monetization/apply" },
      { operationId: "monetization.get", method: "get", path: "/v1/monetization/get" },
    ])
  })

  // The SDK is generated from the served spec, so a schema zod-to-openapi cannot
  // serialize would break /openapi.json for every route, not just these two.
  it("serializes into the OpenAPI document", () => {
    const app = new OpenAPIHono<HonoEnv>()
    registerApplyMonetizationV1(app)
    registerGetMonetizationV1(app)

    const document = app.getOpenAPIDocument({
      openapi: "3.0.3",
      info: { title: "Unprice API", version: "1.0.0" },
    })

    expect(Object.keys(document.paths)).toEqual(["/v1/monetization/apply", "/v1/monetization/get"])
    expect(document.paths["/v1/monetization/apply"]?.post?.requestBody).toBeDefined()
  })

  it("declares both as public SDK operations in the configuration category", () => {
    for (const route of [applyRoute, getRoute]) {
      expect(route["x-unprice"]).toEqual({
        audience: "public",
        category: "configuration",
        docs: { expose: true },
        sdk: { path: ["monetization", route.operationId.split(".")[1]] },
      })
    }
  })
})

describe("monetization.apply", () => {
  it("takes the project from the token, never from the request", async () => {
    const harness = createHarness()

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    expect(response.status).toBe(200)
    expect(useCaseMocks.applyMonetizationConfig).toHaveBeenCalledTimes(1)
    expect(useCaseMocks.applyMonetizationConfig.mock.calls[0]?.[1]).toMatchObject({
      projectId: "proj_123",
      config: { plans: [{ version: { paymentMethodRequired: false } }] },
    })
  })

  // The project could never have come from the body, but silently dropping the
  // key would let a plausible mistake — `{ config, plans }`, since the document
  // itself has a `plans` key — return 200 with the extra ignored.
  it("rejects an unknown top-level key instead of ignoring it", async () => {
    const harness = createHarness()

    const config = validConfig()
    // A nested typo is the likelier agent mistake, and it is the only case where
    // the container prefix does any work: Zod reports the key against its parent
    // object, so the top-level case alone cannot tell a correct prefix from none.
    ;(config.plans[0] as unknown as Record<string, unknown>).trialDays = 14

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { projectId: "proj_attacker", config },
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { details: { kind: string; issues: Array<{ path: string; message: string }> } }
    }

    expect(body.error.details.kind).toBe("invalid_config")
    // the offending key is addressable as a path, not just named in prose
    expect(body.error.details.issues).toContainEqual({
      path: "projectId",
      message: 'Unrecognized key "projectId"',
    })
    expect(body.error.details.issues).toContainEqual({
      path: "config.plans[0].trialDays",
      message: 'Unrecognized key "trialDays"',
    })
    expect(body.error.details.issues.every((issue) => issue.path !== "")).toBe(true)
    expect(useCaseMocks.applyMonetizationConfig).not.toHaveBeenCalled()
    // and the smuggled value is never echoed back
    expect(JSON.stringify(body)).not.toContain("proj_attacker")
  })

  it("returns the use case outcomes with a review url for the first created draft", async () => {
    useCaseMocks.applyMonetizationConfig.mockResolvedValue(
      applyOk(
        [
          { slug: "free", planVersionId: "pv_free", status: "unchanged" },
          { slug: "pro", planVersionId: "pv_pro", status: "created" },
          { slug: "team", planVersionId: "pv_team", status: "created" },
        ],
        [{ slug: "pro", planVersionId: "pv_old" }]
      )
    )
    const harness = createHarness()

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      plans: [
        { slug: "free", planVersionId: "pv_free", status: "unchanged" },
        { slug: "pro", planVersionId: "pv_pro", status: "created" },
        { slug: "team", planVersionId: "pv_team", status: "created" },
      ],
      staleDrafts: [{ slug: "pro", planVersionId: "pv_old" }],
      integrationContract: INTEGRATION_CONTRACT,
      // built from the repo's canonical dashboard base URL, never a literal domain
      reviewUrl: new URL("/acme-workspace/acme-api/plans/pro/pv_pro", APP_DOMAIN).toString(),
    })
  })

  it("points the review url at the dashboard plan-version page for the first created draft", async () => {
    useCaseMocks.applyMonetizationConfig.mockResolvedValue(
      applyOk([
        { slug: "free", planVersionId: "pv_free", status: "published" },
        { slug: "pro", planVersionId: "pv_pro", status: "created" },
      ])
    )
    const harness = createHarness({ workspaceSlug: "acme-workspace" })

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    const { reviewUrl } = (await response.json()) as { reviewUrl: string }

    expect(new URL(reviewUrl).pathname).toBe("/acme-workspace/acme-api/plans/pro/pv_pro")
    expect(new URL(reviewUrl).origin).toBe(new URL(APP_DOMAIN).origin)
  })

  // A plan slug is caller-supplied and echoed back from the document, and is only
  // validated for length. An unencoded "/" would not break the link, it would add
  // a path segment — silently addressing a different, possibly real, plan page.
  it("encodes slugs so a separator in one cannot add a path segment", async () => {
    useCaseMocks.applyMonetizationConfig.mockResolvedValue(
      applyOk([{ slug: "a b/c", planVersionId: "pv_1", status: "created" }])
    )
    const harness = createHarness()

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    const { reviewUrl } = (await response.json()) as { reviewUrl: string }
    const segments = new URL(reviewUrl).pathname.split("/")

    // ["", workspace, project, "plans", slug, planVersionId] — six, never seven
    expect(segments).toHaveLength(6)
    expect(decodeURIComponent(segments[4] ?? "")).toBe("a b/c")
    expect(segments[5]).toBe("pv_1")
  })

  // `encodeURIComponent` throws URIError on a lone surrogate. The drafts are
  // already written by this point, and apply is idempotent by hash, so a throw
  // here would make every retry of the same document reproduce the same 500 and
  // the caller could never obtain the outcomes for work the server did.
  it("still returns the outcomes when a slug cannot be encoded", async () => {
    useCaseMocks.applyMonetizationConfig.mockResolvedValue(
      applyOk([{ slug: "pro\ud800", planVersionId: "pv_1", status: "created" }])
    )
    const harness = createHarness()

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { reviewUrl: string | null; plans: unknown[] }

    expect(body.reviewUrl).toBeNull()
    expect(body.plans).toHaveLength(1)
  })

  it("returns a null review url when nothing was created", async () => {
    useCaseMocks.applyMonetizationConfig.mockResolvedValue(
      applyOk([
        { slug: "free", planVersionId: "pv_free", status: "unchanged" },
        { slug: "pro", planVersionId: "pv_pro", status: "published" },
      ])
    )
    const harness = createHarness()

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ reviewUrl: null })
  })

  // The deploy-window case the compiler cannot see: a key served from a cache
  // entry written before `workspace.slug` was selected. Emitting the outcomes
  // with a null link beats emitting `/undefined/acme-api/plans/...`, which looks
  // real and resolves to nothing, for the 24h the stale entry stays servable.
  it("returns a null review url for a cached key that predates the workspace slug", async () => {
    const harness = createHarness({ workspaceSlug: null })

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { reviewUrl: string | null; plans: unknown[] }

    expect(body.reviewUrl).toBeNull()
    // the outcomes are still the result; only the courtesy link is missing
    expect(body.plans).toEqual([{ slug: "free", planVersionId: "pv_1", status: "created" }])
  })

  it("never emits a review url containing an unresolved path segment", async () => {
    const harness = createHarness({ workspaceSlug: null })

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    expect(await response.text()).not.toContain("undefined")
  })

  it("rejects an invalid document with JSON paths an agent can act on", async () => {
    const config = validConfig()
    // prices a feature the document never declares: caught by the config schema
    config.plans[0]!.version.features[0]!.featureSlug = "not-declared"
    const harness = createHarness()

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config },
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: {
        code: string
        requestId: string
        details: { kind: string; issues: Array<{ path: string; message: string }> }
      }
    }

    expect(body.error.code).toBe("BAD_REQUEST")
    expect(body.error.requestId).toBe("req_test")
    expect(body.error.details.kind).toBe("invalid_config")
    expect(body.error.details.issues).toContainEqual({
      path: "config.plans[0].version.features[0].featureSlug",
      message: expect.stringContaining("not-declared"),
    })
    expect(useCaseMocks.applyMonetizationConfig).not.toHaveBeenCalled()
  })

  it("reports a missing required field as an invalid_config issue", async () => {
    const harness = createHarness()

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: { events: [], features: [], plans: [] } },
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { details: { kind: string; issues: Array<{ path: string }> } }
    }
    expect(body.error.details.kind).toBe("invalid_config")
    expect(body.error.details.issues.map((issue) => issue.path)).toContain("config.plans")
  })

  it("maps slug_conflict to a conflict carrying the structured kind", async () => {
    useCaseMocks.applyMonetizationConfig.mockResolvedValue(
      Ok({
        state: "slug_conflict" as const,
        slug: "support",
        message: 'Feature "support" already exists in this project measured in "seat"',
      })
    )
    const harness = createHarness()

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CONFLICT",
        docs: expect.stringContaining("CONFLICT"),
        message: 'Feature "support" already exists in this project measured in "seat"',
        requestId: "req_test",
        details: { kind: "slug_conflict" },
      },
    })
  })

  it("maps unresolved_reference to a bad request carrying the structured kind", async () => {
    useCaseMocks.applyMonetizationConfig.mockResolvedValue(
      Ok({
        state: "unresolved_reference" as const,
        slug: "chat_request",
        message:
          'Feature "chat-messages" meters event "chat_request", which this document does not declare',
      })
    )
    const harness = createHarness()

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { details: { kind: string } } }
    expect(body.error.details.kind).toBe("unresolved_reference")
  })

  it("maps a write failure to its own status and names where it happened", async () => {
    useCaseMocks.applyMonetizationConfig.mockResolvedValue(
      Ok({ state: "plan_version_published" as const, planSlug: "pro" })
    )
    const harness = createHarness()

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("CONFLICT")
    expect(body.error.message).toContain("plan_version_published")
    expect(body.error.message).toContain("pro")
  })

  it("maps a missing row write failure to an internal failure without leaking the document", async () => {
    useCaseMocks.applyMonetizationConfig.mockResolvedValue(
      Ok({ state: "plan_not_found" as const, planSlug: "pro" })
    )
    const harness = createHarness()

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    expect(response.status).toBe(500)
    // Pinned exactly rather than by absence: asserting the document is missing
    // passes for any body that happens not to contain those strings, including
    // one that leaks `plan_not_found (plan "pro")`. The whole body is the claim.
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        docs: "https://docs.unprice.dev/api-reference/errors/code/INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        requestId: "req_test",
      },
    })
  })

  it("maps a transport failure to an internal error, distinct from any configuration outcome", async () => {
    useCaseMocks.applyMonetizationConfig.mockResolvedValue({
      err: new FetchError({ message: "connection reset to db-primary", retry: true }),
      val: undefined,
    })
    const harness = createHarness()

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR")
    // the raw database message never reaches the caller
    expect(body.error.message).not.toContain("db-primary")
    expect(body.error).not.toHaveProperty("details")
  })
})

describe("monetization.get", () => {
  it("takes the project from the token and returns the document with its state", async () => {
    const harness = createHarness()

    const response = await harness.fetch({ path: "/v1/monetization/get", method: "GET" })

    expect(response.status).toBe(200)
    expect(useCaseMocks.getMonetizationConfig.mock.calls[0]?.[1]).toEqual({ projectId: "proj_123" })
    await expect(response.json()).resolves.toEqual({
      config: validConfig(),
      plans: [{ slug: "free", publishedVersionId: null, draftVersionIds: ["pv_1"] }],
      unrepresentablePlans: [],
      warnings: [],
      integrationContract: INTEGRATION_CONTRACT,
    })
  })

  it("surfaces warnings and unrepresentable plans instead of flattening them into text", async () => {
    useCaseMocks.getMonetizationConfig.mockResolvedValue(
      Ok({
        state: "ok" as const,
        config: validConfig(),
        plans: [{ slug: "free", publishedVersionId: "pv_live", draftVersionIds: [] }],
        unrepresentablePlans: [
          { slug: "legacy", reason: "no_version", message: "Plan has no versions" },
        ],
        warnings: [
          {
            planSlug: "free",
            featureSlug: null,
            code: "enforcement_settings_dropped",
            message: "Trial days are not expressible",
          },
          {
            planSlug: "free",
            featureSlug: "support",
            code: "feature_settings_dropped",
            message: "Hidden flag is not expressible",
          },
        ],
        integrationContract: null,
      })
    )
    const harness = createHarness()

    const response = await harness.fetch({ path: "/v1/monetization/get", method: "GET" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      unrepresentablePlans: [
        { slug: "legacy", reason: "no_version", message: "Plan has no versions" },
      ],
      warnings: [
        { planSlug: "free", featureSlug: null, code: "enforcement_settings_dropped" },
        { planSlug: "free", featureSlug: "support", code: "feature_settings_dropped" },
      ],
      integrationContract: null,
    })
  })

  it("maps a configuration the boundary cannot state to a precondition failure", async () => {
    useCaseMocks.getMonetizationConfig.mockResolvedValue(
      Ok({ state: "no_default_plan" as const, message: "This project has no default plan" })
    )
    const harness = createHarness()

    const response = await harness.fetch({ path: "/v1/monetization/get", method: "GET" })

    expect(response.status).toBe(412)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("PRECONDITION_FAILED")
    expect(body.error.message).toBe("This project has no default plan")
  })

  it("maps two default plans to a conflict", async () => {
    useCaseMocks.getMonetizationConfig.mockResolvedValue(
      Ok({ state: "multiple_default_plans" as const, message: "free, pro" })
    )
    const harness = createHarness()

    const response = await harness.fetch({ path: "/v1/monetization/get", method: "GET" })

    expect(response.status).toBe(409)
  })

  it("maps a transport failure to an internal error", async () => {
    useCaseMocks.getMonetizationConfig.mockResolvedValue({
      err: new FetchError({ message: "read replica timeout", retry: true }),
      val: undefined,
    })
    const harness = createHarness()

    const response = await harness.fetch({ path: "/v1/monetization/get", method: "GET" })

    expect(response.status).toBe(500)
  })
})

// The two directions of the key-type boundary, exercised through the real
// `keyAuth` and the real routes rather than a mocked auth module: a mocked
// `keyAuth` would only prove the mock rejects what it was told to reject.
describe("config key boundary", () => {
  it("rejects a runtime key on monetization.apply", async () => {
    const harness = createHarness({ keyType: "runtime" })

    const response = await harness.fetch({
      path: "/v1/monetization/apply",
      method: "POST",
      body: { config: validConfig() },
    })

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("INSUFFICIENT_PERMISSIONS")
    expect(useCaseMocks.applyMonetizationConfig).not.toHaveBeenCalled()
  })

  it("rejects a runtime key on monetization.get", async () => {
    const harness = createHarness({ keyType: "runtime" })

    const response = await harness.fetch({ path: "/v1/monetization/get", method: "GET" })

    expect(response.status).toBe(403)
    expect(useCaseMocks.getMonetizationConfig).not.toHaveBeenCalled()
  })

  it("rejects a config key on usage.consume with the identical failure", async () => {
    const runtimeOnConfigRoute = await createHarness({ keyType: "runtime" }).fetch({
      path: "/v1/monetization/get",
      method: "GET",
    })
    const configOnRuntimeRoute = await createHarness({ keyType: "config" }).fetch({
      path: "/v1/usage/consume",
      method: "POST",
      body: consumeBody,
    })

    expect(configOnRuntimeRoute.status).toBe(403)
    // a caller must not be able to tell which key type each route wanted
    await expect(configOnRuntimeRoute.json()).resolves.toEqual(await runtimeOnConfigRoute.json())
  })

  // Control for the test above: the same request with a runtime key goes through,
  // so the 403 is the key type and not a broken fixture.
  it("lets a runtime key through usage.consume", async () => {
    const harness = createHarness({ keyType: "runtime" })

    const response = await harness.fetch({
      path: "/v1/usage/consume",
      method: "POST",
      body: consumeBody,
    })

    expect(response.status).toBe(200)
  })
})
