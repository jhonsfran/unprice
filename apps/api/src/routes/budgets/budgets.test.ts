import { OpenAPIHono } from "@hono/zod-openapi"
import { Err, Ok } from "@unprice/error"
import { type BudgetBalance, UnPriceBudgetError } from "@unprice/services/budgets"
import type { ExecutionContext, MiddlewareHandler } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError, handleError, handleZodError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import type { BudgetTelemetry } from "~/ingestion/budget/BudgetDO"
import { placementTiming } from "~/middleware/placement-timing"
import { registerAuthorizeBudgetV1 } from "./authorizeBudgetV1"
import { registerChargeBudgetV1 } from "./chargeBudgetV1"
import { registerGetBudgetV1 } from "./getBudgetV1"
import { registerLeaseBudgetV1 } from "./leaseBudgetV1"
import { registerRecordBudgetV1 } from "./recordBudgetV1"
import { registerReleaseBudgetV1 } from "./releaseBudgetV1"
import { registerReportBudgetV1 } from "./reportBudgetV1"
import { registerSettleBudgetV1 } from "./settleBudgetV1"
import { registerUpsertBudgetV1 } from "./upsertBudgetV1"

const mocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
  execute: vi.fn(),
  telemetry: undefined as BudgetTelemetry | undefined,
  log: vi.fn(),
}))

vi.mock("~/auth/key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/auth/key")>()),
  keyAuth: mocks.keyAuth,
}))

vi.mock("~/ingestion/budget/client", () => ({
  CloudflareBudgetClient: class {
    execute = mocks.execute
    telemetry = mocks.telemetry
  },
}))

const ONE = BigInt(100_000_000)
const usd = (value: number) => BigInt(value) * ONE

const balance = (remaining: bigint, held = BigInt(0)): BudgetBalance => ({
  remaining,
  held,
  limits: [
    {
      id: "month",
      window: "month",
      enforce: "hard",
      amount: usd(50),
      consumed: usd(50) - remaining - held,
      held,
      remaining,
      resetsAt: 1_798_761_600_000,
    },
  ],
  asOf: 1_796_083_200_000,
})

beforeEach(() => {
  mocks.keyAuth.mockResolvedValue({ id: "key_1", projectId: "proj_123" })
})

afterEach(() => {
  vi.clearAllMocks()
  mocks.telemetry = undefined
})

/** The request logger, whose `set` fields become the request's wide event. */
const withLogger: MiddlewareHandler<HonoEnv> = async (c, next) => {
  c.set("logger", { set: mocks.log } as unknown as HonoEnv["Variables"]["logger"])
  await next()
}

function createTestApp() {
  const app = new OpenAPIHono<HonoEnv>({ defaultHook: handleZodError })
  app.onError(handleError)
  app.use("*", async (c, next) => {
    c.set("requestId", "req_test")
    await next()
  })
  app.use("*", withLogger)
  for (const register of [
    registerUpsertBudgetV1,
    registerAuthorizeBudgetV1,
    registerSettleBudgetV1,
    registerReleaseBudgetV1,
    registerChargeBudgetV1,
    registerRecordBudgetV1,
    registerGetBudgetV1,
    registerLeaseBudgetV1,
    registerReportBudgetV1,
  ]) {
    register(app)
  }
  return app
}

async function call(path: string, body?: unknown) {
  return createTestApp().fetch(
    new Request(`https://example.com${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer key", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { APP_ENV: "development" },
    { passThroughOnException: vi.fn(), waitUntil: vi.fn() } as unknown as ExecutionContext
  )
}

const rejectWith = (rejection: ConstructorParameters<typeof UnPriceBudgetError>[0]) =>
  mocks.execute.mockResolvedValue(Err(new UnPriceBudgetError(rejection)))

/** The whole versioned error body the handler emits, so an added or renamed field fails. */
const errorBody = (code: string, message: string, details?: Record<string, unknown>) => ({
  error: {
    code,
    docs: `https://docs.unprice.dev/api-reference/errors/code/${code}`,
    message,
    requestId: "req_test",
    ...(details ? { details } : {}),
  },
})

describe("budgets API", () => {
  it("serializes into the OpenAPI document with the 402 on gated verbs", () => {
    const document = createTestApp().getOpenAPIDocument({
      openapi: "3.0.3",
      info: { title: "Unprice API", version: "1.0.0" },
    })

    expect(Object.keys(document.paths)).toEqual([
      "/v1/budgets/upsert",
      "/v1/budgets/authorize",
      "/v1/budgets/settle",
      "/v1/budgets/release",
      "/v1/budgets/charge",
      "/v1/budgets/record",
      "/v1/budgets/get",
      "/v1/budgets/lease",
      "/v1/budgets/report",
    ])
    const statuses = (path: string) =>
      Object.keys(document.paths[path]?.post?.responses ?? {}).filter((status) => status === "402")
    expect(
      ["authorize", "charge", "record", "lease", "report"].map((verb) =>
        statuses(`/v1/budgets/${verb}`)
      )
    ).toEqual([["402"], ["402"], [], ["402"], []])
  })

  it("returns settlement maximum and actual on an over-reservation conflict", async () => {
    rejectWith({ code: "HOLD_AMOUNT_EXCEEDED", holdId: "h_1", maximum: usd(10), actual: usd(11) })
    const response = await call("/v1/budgets/settle", { key: "k", holdId: "h_1", amount: "11" })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(
      errorBody("CONFLICT", "Hold h_1 permits 10, not 11", {
        kind: "hold_amount_exceeded",
        holdId: "h_1",
        maximum: "10",
        actual: "11",
      })
    )
  })

  it("returns the minimum cap when a configuration is below committed usage", async () => {
    rejectWith({
      code: "LIMIT_BELOW_USAGE",
      limitId: "month",
      minimum: usd(90),
      requested: usd(80),
    })
    const response = await call("/v1/budgets/upsert", {
      key: "k",
      unit: "USD",
      limits: [{ id: "month", amount: "80", window: "month" }],
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(
      errorBody("CONFLICT", "Limit month must cover 90 consumed or held", {
        kind: "limit_below_usage",
        limitId: "month",
        minimum: "90",
        requested: "80",
      })
    )
  })

  it.each(["allow", { allowUpTo: "1" }])("refuses fail-open policy %j", async (onUnavailable) => {
    const response = await call("/v1/budgets/upsert", {
      key: "k",
      unit: "USD",
      limits: [],
      onUnavailable,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } })
  })

  it("returns the retained schedule bound on a configuration conflict", async () => {
    rejectWith({ code: "WINDOW_CAPACITY_EXCEEDED", maximum: 32, retained: 32 })
    const response = await call("/v1/budgets/upsert", { key: "k", unit: "USD", limits: [] })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(
      errorBody(
        "CONFLICT",
        "Budget retains 32 anchored schedules; at most 32 can remain active or in their current period",
        { kind: "window_capacity_exceeded", maximum: 32, retained: 32 }
      )
    )
  })

  it("rejects a request without a valid key", async () => {
    mocks.keyAuth.mockRejectedValue(
      new UnpriceApiError({ code: "UNAUTHORIZED", message: "key required" })
    )

    const response = await call("/v1/budgets/charge", {
      key: "customer:acme",
      amount: "1",
      idempotencyKey: "c1",
    })

    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED")
  })

  it.each([
    ["runtime", false],
    ["config", true],
  ] as const)("lets a %s key upsert, loosening only with a config key", async (type, mayLoosen) => {
    mocks.keyAuth.mockResolvedValue({ id: "key_1", projectId: "proj_123", type })
    rejectWith({ code: "BUDGET_NOT_FOUND" })

    await call("/v1/budgets/upsert", { key: "customer:acme", unit: "USD", limits: [] })

    expect(mocks.keyAuth).toHaveBeenCalledWith(expect.anything(), {
      requireType: ["runtime", "config"],
    })
    expect(mocks.execute.mock.calls[0]?.[1]).toMatchObject({ type: "upsert", mayLoosen })
  })

  it("authenticates every other verb with a runtime key only", async () => {
    rejectWith({ code: "BUDGET_NOT_FOUND" })

    await call("/v1/budgets/charge", { key: "customer:acme", amount: "1", idempotencyKey: "c1" })

    expect(mocks.keyAuth).toHaveBeenCalledWith(expect.anything())
  })

  it("returns 403 naming the config key when a runtime key loosens a budget", async () => {
    rejectWith({
      code: "LOOSENING_FORBIDDEN",
      change: { change: "limit.amount", limitId: "month", from: usd(50), to: usd(500) },
    })

    const response = await call("/v1/budgets/upsert", {
      key: "customer:acme",
      unit: "USD",
      limits: [{ id: "month", amount: "500", window: "month" }],
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(
      errorBody(
        "INSUFFICIENT_PERMISSIONS",
        "This caller cannot loosen the budget: the upsert raises hard limit month from 50 to 500. A runtime key can create or tighten a budget; raising or removing a hard limit, making it soft, or clearing or postponing closesAt needs a config key."
      )
    )
  })

  it.each([
    ["an amount with nine decimals", { key: "customer:acme", amount: "0.123456789" }],
    ["a negative amount", { key: "customer:acme", amount: "-1" }],
    ["a key with a space", { key: "customer acme", amount: "1" }],
    ["an unknown field", { key: "customer:acme", amount: "1", parent: "org" }],
  ])("returns 400 for %s", async (_name, body) => {
    const response = await call("/v1/budgets/authorize", { ...body, idempotencyKey: "a1" })

    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST")
  })

  it("holds an amount and answers in decimal strings with the remaining header", async () => {
    mocks.execute.mockResolvedValue(
      Ok({
        type: "authorize",
        holdId: "h_1",
        amount: usd(10),
        expiresAt: 1_796_084_100_000,
        replayed: false,
        balance: balance(usd(40), usd(10)),
      })
    )

    const response = await call("/v1/budgets/authorize", {
      key: "customer:acme/run:1",
      amount: "10",
      idempotencyKey: "a1",
    })

    expect(mocks.execute).toHaveBeenCalledWith(
      { projectId: "proj_123", key: "customer:acme/run:1" },
      { type: "authorize", idempotencyKey: "a1", ttlMs: undefined, amount: usd(10) }
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Unprice-Budget-Remaining")).toBe("40")
    expect(await response.json()).toEqual({
      allowed: true,
      holdId: "h_1",
      amount: "10",
      expiresAt: 1_796_084_100_000,
      replayed: false,
      balance: {
        remaining: "40",
        held: "10",
        limits: [
          {
            id: "month",
            window: "month",
            enforce: "hard",
            amount: "50",
            consumed: "0",
            held: "10",
            remaining: "40",
            resetsAt: 1_798_761_600_000,
          },
        ],
        asOf: 1_796_083_200_000,
      },
    })
  })

  it("reports the budget call on the wide event everywhere and its placement and queue outside production", async () => {
    mocks.execute.mockResolvedValue(
      Ok({
        type: "authorize",
        holdId: "h_1",
        amount: usd(10),
        expiresAt: 1_796_084_100_000,
        replayed: false,
        balance: balance(usd(40), usd(10)),
      })
    )
    const app = new OpenAPIHono<HonoEnv>({ defaultHook: handleZodError })
    app.use(timing())
    app.use(placementTiming())
    app.use("*", withLogger)
    registerAuthorizeBudgetV1(app)
    const serverTiming = async (APP_ENV: string, telemetry: BudgetTelemetry) => {
      mocks.telemetry = telemetry
      const request = new Request("https://example.com/v1/budgets/authorize", {
        method: "POST",
        headers: { authorization: "Bearer key", "content-type": "application/json" },
        body: JSON.stringify({ key: "customer:acme", amount: "10", idempotencyKey: "a1" }),
      })
      const response = await app.fetch(
        Object.assign(request, { cf: { colo: "EWR" } }),
        { APP_ENV },
        { passThroughOnException: vi.fn(), waitUntil: vi.fn() } as unknown as ExecutionContext
      )
      expect(response.status).toBe(200)
      return response.headers.get("Server-Timing")
    }

    expect(await serverTiming("preview", { cold: true, served: 1, colo: "LHR" })).toMatch(
      /^edge;desc="EWR",isolate;desc="cold",budget;dur=\d+\.\d;desc="do=LHR cold",total;dur=\d+\.\d;desc="Total Response Time"$/
    )
    expect(mocks.log).toHaveBeenLastCalledWith({
      budget: {
        command: "authorize",
        outcome: "ok",
        do_ms: expect.any(Number),
        cold: true,
        served: 1,
        colo: "LHR",
      },
    })
    expect(await serverTiming("preview", { cold: false, served: 7, colo: "unknown" })).toMatch(
      /^edge;desc="EWR",isolate;desc="warm",budget;dur=\d+\.\d;desc="do=unknown warm",total;/
    )
    expect(await serverTiming("production", { cold: false, served: 2 })).toMatch(
      /^budget;dur=\d+\.\d,total;dur=\d+\.\d;desc="Total Response Time"$/
    )
    expect(mocks.log).toHaveBeenLastCalledWith({
      budget: {
        command: "authorize",
        outcome: "ok",
        do_ms: expect.any(Number),
        cold: false,
        served: 2,
      },
    })
  })

  it("names the rejection, or an error, as the budget call's outcome", async () => {
    mocks.telemetry = { cold: false, served: 4 }
    rejectWith({ code: "BUDGET_NOT_FOUND" })
    expect((await call("/v1/budgets/get?key=customer:missing")).status).toBe(404)
    expect(mocks.log).toHaveBeenLastCalledWith({
      budget: {
        command: "get",
        outcome: "BUDGET_NOT_FOUND",
        do_ms: expect.any(Number),
        cold: false,
        served: 4,
      },
    })

    mocks.telemetry = undefined
    mocks.execute.mockRejectedValue(new Error("Durable Object reset"))
    expect((await call("/v1/budgets/get?key=customer:missing")).status).toBe(500)
    expect(mocks.log).toHaveBeenLastCalledWith({
      budget: { command: "get", outcome: "error", do_ms: expect.any(Number) },
    })
  })

  it("returns 402 with the blocking limit when a charge does not fit", async () => {
    rejectWith({
      code: "LIMIT_EXCEEDED",
      blocked: {
        limitId: "month",
        window: "month",
        remaining: usd(1) / BigInt(2),
        held: BigInt(0),
        resetsAt: 1_798_761_600_000,
        remedy: "wait_for_reset",
      },
      balance: balance(usd(1) / BigInt(2)),
    })

    const response = await call("/v1/budgets/charge", {
      key: "customer:acme",
      amount: "2",
      idempotencyKey: "c1",
    })

    expect(response.status).toBe(402)
    expect(response.headers.get("Unprice-Budget-Remaining")).toBe("0.5")
    const body = (await response.json()) as {
      error: { code: string; details: { kind: string; blocked: unknown; balance: unknown } }
    }
    expect(body.error.code).toBe("BUDGET_EXCEEDED")
    expect(body.error.details.kind).toBe("budget_exceeded")
    expect(body.error.details.blocked).toEqual({
      limitId: "month",
      window: "month",
      remaining: "0.5",
      held: "0",
      resetsAt: 1_798_761_600_000,
      remedy: "wait_for_reset",
    })
  })

  it.each([
    ["/v1/budgets/charge", { code: "IDEMPOTENCY_CONFLICT", idempotencyKey: "c1" }, 409, "CONFLICT"],
    [
      "/v1/budgets/settle",
      { code: "HOLD_CLOSED", holdId: "h_1", status: "released" },
      409,
      "CONFLICT",
    ],
    ["/v1/budgets/release", { code: "HOLD_RETIRED", holdId: "h_1" }, 409, "CONFLICT"],
    [
      "/v1/budgets/upsert",
      { code: "UNIT_IMMUTABLE", current: "money:USD", requested: "money:EUR" },
      409,
      "CONFLICT",
    ],
    ["/v1/budgets/release", { code: "HOLD_NOT_FOUND", holdId: "h_1" }, 404, "NOT_FOUND"],
    ["/v1/budgets/record", { code: "BUDGET_NOT_FOUND" }, 404, "NOT_FOUND"],
    [
      "/v1/budgets/record",
      { code: "TOO_LATE", occurredAt: 1, oldestAccepted: 604_800_001 },
      409,
      "CONFLICT",
    ],
    [
      "/v1/budgets/record",
      { code: "INVALID_OCCURRED_AT", occurredAt: 400_000, latestAccepted: 300_000 },
      400,
      "BAD_REQUEST",
    ],
    [
      "/v1/budgets/authorize",
      { code: "INVALID_TTL", ttlMs: 5, minTtlMs: 1_000, maxTtlMs: 86_400_000 },
      400,
      "BAD_REQUEST",
    ],
  ] as const)("maps a %s rejection to its status", async (path, rejection, status, code) => {
    rejectWith(rejection)
    const bodies: Record<string, unknown> = {
      "/v1/budgets/charge": { key: "k", amount: "1", idempotencyKey: "c1" },
      "/v1/budgets/settle": { key: "k", holdId: "h_1", amount: "1" },
      "/v1/budgets/upsert": { key: "k", unit: "EUR", limits: [] },
      "/v1/budgets/release": { key: "k", holdId: "h_1" },
      "/v1/budgets/record": { key: "k", amount: "1", idempotencyKey: "r1", occurredAt: 1 },
      "/v1/budgets/authorize": { key: "k", amount: "1", idempotencyKey: "a1", ttlMs: 5 },
    }

    const response = await call(path, bodies[path])

    expect(response.status).toBe(status)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code)
  })

  it("returns 409 with closedAt once the budget is past closesAt", async () => {
    rejectWith({ code: "BUDGET_CLOSED", closedAt: 1_798_761_600_000 })

    const response = await call("/v1/budgets/charge", {
      key: "customer:acme",
      amount: "1",
      idempotencyKey: "c1",
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(
      errorBody("CONFLICT", "Budget closed at 2027-01-01T00:00:00.000Z", {
        kind: "budget_closed",
        closedAt: 1_798_761_600_000,
      })
    )
  })

  it("requires occurredAt on record and passes it to the budget", async () => {
    const missing = await call("/v1/budgets/record", {
      key: "customer:acme",
      amount: "1",
      idempotencyKey: "r1",
    })
    expect(missing.status).toBe(400)

    rejectWith({ code: "BUDGET_NOT_FOUND" })
    await call("/v1/budgets/record", {
      key: "customer:acme",
      amount: "1",
      idempotencyKey: "r1",
      occurredAt: 1_796_083_200_000,
    })
    expect(mocks.execute).toHaveBeenCalledWith(
      { projectId: "proj_123", key: "customer:acme" },
      {
        type: "record",
        idempotencyKey: "r1",
        occurredAt: 1_796_083_200_000,
        amount: usd(1),
      }
    )
  })

  it("answers a get with instants in epoch ms, the closed flag, the operation counts, and the window history", async () => {
    const anchor = Date.parse("2026-10-15T00:00:00.000Z")
    mocks.execute.mockResolvedValue(
      Ok({
        type: "get",
        budget: {
          key: "customer:acme",
          unit: "money:USD",
          version: 2,
          limits: [{ id: "billing", amount: usd(50), window: "month", anchor, enforce: "hard" }],
          holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
          onUnavailable: "deny",
          closesAt: 1_798_761_600_000,
          closed: false,
          balance: balance(usd(40)),
          operations: { upsert: 2, authorize: 7, settle: 6, release: 1, charge: 3, record: 4 },
        },
        history: [
          {
            windowId: "month@2026-10-15T00:00:00.000Z",
            start: Date.parse("2026-09-15T00:00:00.000Z"),
            end: anchor,
            consumed: usd(12),
          },
        ],
      })
    )

    const response = await call("/v1/budgets/get?key=customer:acme")

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      budget: {
        version: 2,
        limits: [
          {
            id: "billing",
            amount: "50",
            window: "month",
            anchor: 1_792_022_400_000,
            enforce: "hard",
          },
        ],
        closesAt: 1_798_761_600_000,
        closed: false,
        balance: { remaining: "40" },
        operations: { upsert: 2, authorize: 7, settle: 6, release: 1, charge: 3, record: 4 },
      },
      history: [
        {
          windowId: "month@2026-10-15T00:00:00.000Z",
          start: 1_789_430_400_000,
          end: 1_792_022_400_000,
          consumed: "12",
        },
      ],
    })
  })

  const lease = {
    leaseKey: "lease_1",
    seq: 0,
    granted: usd(5),
    captured: BigInt(0),
    expiresAt: 1_796_083_260_000,
    status: "open" as const,
  }
  const terms = { holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 }, closesAt: null }
  const wireBalance = (remaining: string, held: string, consumed: string) => ({
    remaining,
    held,
    limits: [
      {
        id: "month",
        window: "month",
        enforce: "hard",
        amount: "50",
        consumed,
        held,
        remaining,
        resetsAt: 1_798_761_600_000,
      },
    ],
    asOf: 1_796_083_200_000,
  })

  it("grants a lease and answers in decimal strings with the remaining header", async () => {
    mocks.execute.mockResolvedValue(
      Ok({ type: "lease", lease, terms, replayed: false, balance: balance(usd(45), usd(5)) })
    )

    const response = await call("/v1/budgets/lease", {
      key: "customer:acme",
      leaseKey: "lease_1",
      amount: "5",
      ttlMs: 60_000,
    })

    expect(mocks.execute).toHaveBeenCalledWith(
      { projectId: "proj_123", key: "customer:acme" },
      { type: "lease", leaseKey: "lease_1", amount: usd(5), ttlMs: 60_000 }
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Unprice-Budget-Remaining")).toBe("45")
    expect(await response.json()).toEqual({
      lease: {
        leaseKey: "lease_1",
        seq: 0,
        granted: "5",
        captured: "0",
        expiresAt: 1_796_083_260_000,
        status: "open",
      },
      terms,
      replayed: false,
      balance: wireBalance("45", "5", "0"),
    })
  })

  it("answers a short extension with the details of a denied charge, and the capture applied", async () => {
    const blocked = {
      limitId: "month",
      window: "month" as const,
      remaining: usd(0),
      held: usd(2),
      resetsAt: 1_798_761_600_000,
      remedy: "release_holds" as const,
    }
    mocks.execute.mockResolvedValue(
      Ok({
        type: "report",
        lease: { ...lease, seq: 2, granted: usd(7), captured: usd(3) },
        terms,
        extension: {
          requested: usd(5),
          granted: usd(2),
          denied: { code: "LIMIT_EXCEEDED", blocked },
        },
        released: BigInt(0),
        crossed: [],
        replayed: false,
        balance: balance(usd(0), usd(4)),
      })
    )

    const response = await call("/v1/budgets/report", {
      key: "customer:acme",
      leaseKey: "lease_1",
      seq: 2,
      captured: "3",
      final: false,
      extend: "5",
    })

    expect(mocks.execute).toHaveBeenCalledWith(
      { projectId: "proj_123", key: "customer:acme" },
      {
        type: "report",
        leaseKey: "lease_1",
        seq: 2,
        request: { captured: usd(3), final: false, extend: usd(5) },
      }
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      lease: {
        leaseKey: "lease_1",
        seq: 2,
        granted: "7",
        captured: "3",
        expiresAt: 1_796_083_260_000,
        status: "open",
      },
      terms,
      extension: {
        requested: "5",
        granted: "2",
        denied: {
          kind: "budget_exceeded",
          blocked: {
            limitId: "month",
            window: "month",
            remaining: "0",
            held: "2",
            resetsAt: 1_798_761_600_000,
            remedy: "release_holds",
          },
          balance: wireBalance("0", "4", "46"),
        },
      },
      released: "0",
      crossed: [],
      replayed: false,
      balance: wireBalance("0", "4", "46"),
    })
  })

  it("closes a lease with a final report and refuses a final report that extends", async () => {
    mocks.execute.mockResolvedValue(
      Ok({
        type: "report",
        lease: { ...lease, seq: 1, captured: usd(2), status: "closed" },
        terms: { ...terms, closesAt: 1_798_761_600_000 },
        extension: {
          requested: BigInt(0),
          granted: BigInt(0),
          denied: null,
        },
        released: usd(3),
        crossed: [],
        replayed: true,
        balance: balance(usd(48)),
      })
    )
    const body = { key: "customer:acme", leaseKey: "lease_1", seq: 1, captured: "2", final: true }

    const response = await call("/v1/budgets/report", body)

    expect(mocks.execute.mock.calls[0]?.[1]).toEqual({
      type: "report",
      leaseKey: "lease_1",
      seq: 1,
      request: { captured: usd(2), final: true },
    })
    expect(await response.json()).toEqual({
      lease: {
        leaseKey: "lease_1",
        seq: 1,
        granted: "5",
        captured: "2",
        expiresAt: 1_796_083_260_000,
        status: "closed",
      },
      terms: { ...terms, closesAt: 1_798_761_600_000 },
      extension: { requested: "0", granted: "0" },
      released: "3",
      crossed: [],
      replayed: true,
      balance: wireBalance("48", "0", "2"),
    })
    const extending = await call("/v1/budgets/report", { ...body, extend: "1" })
    expect(extending.status).toBe(400)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      "/v1/budgets/lease",
      {
        code: "LIMIT_EXCEEDED",
        blocked: {
          limitId: "month",
          window: "month",
          remaining: BigInt(0),
          held: usd(50),
          resetsAt: 1_798_761_600_000,
          remedy: "release_holds",
        },
        balance: balance(BigInt(0), usd(50)),
      },
      402,
      errorBody("BUDGET_EXCEEDED", "Limit month has 0 remaining", {
        kind: "budget_exceeded",
        blocked: {
          limitId: "month",
          window: "month",
          remaining: "0",
          held: "50",
          resetsAt: 1_798_761_600_000,
          remedy: "release_holds",
        },
        balance: wireBalance("0", "50", "0"),
      }),
    ],
    [
      "/v1/budgets/report",
      { code: "LEASE_NOT_FOUND", leaseKey: "lease_1" },
      404,
      errorBody("NOT_FOUND", "Lease lease_1 does not exist"),
    ],
    [
      "/v1/budgets/report",
      { code: "LEASE_CLOSED", leaseKey: "lease_1", status: "expired" },
      409,
      errorBody(
        "CONFLICT",
        "Lease lease_1 expired; a final report is accepted only until the alarm counts its remainder"
      ),
    ],
    [
      "/v1/budgets/report",
      { code: "LEASE_SEQ_CONFLICT", leaseKey: "lease_1", seq: 3, requested: 5 },
      409,
      errorBody(
        "CONFLICT",
        "Lease lease_1 applied report 3; expected 4 or an exact retry of 3, got 5"
      ),
    ],
    [
      "/v1/budgets/report",
      {
        code: "LEASE_CAPTURE_OUT_OF_RANGE",
        leaseKey: "lease_1",
        minimum: usd(2),
        maximum: usd(5),
        captured: usd(6),
      },
      409,
      errorBody("CONFLICT", "Lease lease_1 accepts a cumulative capture from 2 to 5, not 6"),
    ],
  ] as const)(
    "maps a lease rejection on %s to its status and body",
    async (path, rejection, status, body) => {
      rejectWith(rejection as ConstructorParameters<typeof UnPriceBudgetError>[0])
      const bodies: Record<string, unknown> = {
        "/v1/budgets/lease": { key: "k", leaseKey: "lease_1", amount: "1", ttlMs: 60_000 },
        "/v1/budgets/report": { key: "k", leaseKey: "lease_1", seq: 5, captured: "6", final: true },
      }

      const response = await call(path, bodies[path])

      expect(response.status).toBe(status)
      expect(await response.json()).toEqual(body)
    }
  )

  it("answers a refused lease, first or replayed, with the 402 of a denial", async () => {
    const blocked = {
      limitId: "month",
      window: "month" as const,
      remaining: BigInt(0),
      held: usd(50),
      resetsAt: 1_798_761_600_000,
      remedy: "release_holds" as const,
    }
    const body = { key: "k", leaseKey: "lease_1", amount: "1", ttlMs: 60_000 }

    for (const replayed of [false, true]) {
      mocks.execute.mockResolvedValue(
        Ok({ type: "refused", blocked, replayed, balance: balance(BigInt(0), usd(50)) })
      )
      const response = await call("/v1/budgets/lease", body)

      expect(response.status).toBe(402)
      expect(response.headers.get("Unprice-Budget-Remaining")).toBe("0")
      expect(await response.json()).toEqual(
        errorBody("BUDGET_EXCEEDED", "Limit month has 0 remaining", {
          kind: "budget_exceeded",
          blocked: { ...blocked, remaining: "0", held: "50" },
          balance: wireBalance("0", "50", "0"),
        })
      )
    }
    expect(mocks.log).toHaveBeenLastCalledWith({
      budget: { command: "lease", outcome: "LIMIT_EXCEEDED", do_ms: expect.any(Number) },
    })
  })

  it("reads a budget by the key in the query string", async () => {
    rejectWith({ code: "BUDGET_NOT_FOUND" })

    const response = await call(`/v1/budgets/get?key=${encodeURIComponent("customer:acme/run:1")}`)

    expect(mocks.execute).toHaveBeenCalledWith(
      { projectId: "proj_123", key: "customer:acme/run:1" },
      { type: "get" }
    )
    expect(response.status).toBe(404)
  })

  it("defaults limit ids to their window and expands a currency unit on upsert", async () => {
    rejectWith({ code: "BUDGET_NOT_FOUND" })

    await call("/v1/budgets/upsert", {
      key: "customer:acme",
      unit: "USD",
      limits: [
        { amount: "50", window: "month" },
        { id: "billing", amount: "50", window: "month", anchor: 1_792_022_400_000 },
      ],
      closesAt: 1_798_761_599_000,
    })

    const [, request] = mocks.execute.mock.calls[0] ?? []
    expect(request).toMatchObject({
      type: "upsert",
      key: "customer:acme",
      projectId: "proj_123",
      unit: "money:USD",
      config: {
        limits: [
          { id: "month", amount: usd(50), window: "month", enforce: "hard" },
          { id: "billing", window: "month", anchor: Date.parse("2026-10-15T00:00:00.000Z") },
        ],
        closesAt: Date.parse("2026-12-31T23:59:59.000Z"),
      },
    })
  })

  it("returns 400 for a config the boundary rejects before reaching the budget", async () => {
    const response = await call("/v1/budgets/upsert", {
      key: "customer:acme",
      unit: "USD",
      limits: [
        { amount: "50", window: "month" },
        { amount: "60", window: "month" },
      ],
    })

    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      "limits.1.id: duplicate limit id month"
    )
    expect(mocks.execute).toHaveBeenCalledTimes(0)
  })
})
