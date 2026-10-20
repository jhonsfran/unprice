import { OpenAPIHono } from "@hono/zod-openapi"
import { upsertBudgetInputSchema } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import { MemoryBudgetStore } from "@unprice/services/budgets/memory-store"
import type { BudgetRequest } from "@unprice/services/use-cases"
import type { ExecutionContext } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleError, handleZodError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { internalKeyAuth } from "~/middleware/internal-key"
import { registerReleaseBudgetInternalV1 } from "./releaseBudgetInternalV1"

const mocks = vi.hoisted(() => ({ keyAuth: vi.fn(), execute: vi.fn(), log: vi.fn() }))

vi.mock("~/auth/key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/auth/key")>()),
  keyAuth: mocks.keyAuth,
}))

vi.mock("~/ingestion/budget/client", () => ({
  CloudflareBudgetClient: class {
    execute = mocks.execute
  },
}))

const keyOf = (project: { isMain: boolean; isInternal: boolean }) => ({
  id: "key_1",
  projectId: "proj_main",
  project: { id: "proj_main", workspaceId: "ws_1", ...project },
})

/** The budget core over an in-memory store, standing in for the budget's Durable Object. */
let store: MemoryBudgetStore
const addresses: unknown[] = []

function run(request: BudgetRequest) {
  const result = store.run(request, Date.now())
  if (result.err) throw result.err
  if (!result.val.ok) throw new Error(`refused: ${result.val.rejection.code}`)
  return result.val.outcome
}

beforeEach(() => {
  store = new MemoryBudgetStore()
  addresses.length = 0
  mocks.execute.mockImplementation(async (address: unknown, request: BudgetRequest) => {
    addresses.push(address)
    const result = store.run(request, Date.now())
    if (result.err) return result
    return result.val.ok ? Ok(result.val.outcome) : result.val
  })
  const { key: _, ...config } = upsertBudgetInputSchema.parse({
    key: "customer:acme",
    unit: "USD",
    limits: [{ id: "month", amount: "50", window: "month" }],
  })
  run({ type: "upsert", ...config, mayLoosen: true })
})

afterEach(() => {
  vi.clearAllMocks()
})

function authorize(idempotencyKey: string): string {
  const held = run({ type: "authorize", amount: BigInt(5) * BigInt(100_000_000), idempotencyKey })
  if (held.type !== "authorize") throw new Error("expected a hold")
  return held.holdId
}

function call(body: unknown) {
  const app = new OpenAPIHono<HonoEnv>({ defaultHook: handleZodError })
  app.onError(handleError)
  app.use("*", async (c, next) => {
    c.set("requestId", "req_test")
    c.set("logger", { set: mocks.log } as unknown as HonoEnv["Variables"]["logger"])
    await next()
  })
  app.use("/v1/internal/*", internalKeyAuth())
  registerReleaseBudgetInternalV1(app)
  return app.fetch(
    new Request("https://example.com/v1/internal/budgets/release", {
      method: "POST",
      headers: { authorization: "Bearer key", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { APP_ENV: "development" },
    { passThroughOnException: vi.fn(), waitUntil: vi.fn() } as unknown as ExecutionContext
  )
}

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string; details?: unknown } }).error

describe("POST /v1/internal/budgets/release", () => {
  it("rejects a tenant key with 403 before reaching the budget", async () => {
    mocks.keyAuth.mockResolvedValue(keyOf({ isMain: false, isInternal: false }))
    const holdId = authorize("job-1")

    const response = await call({ projectId: "proj_tenant", key: "customer:acme", holdId })

    expect([response.status, (await errorOf(response)).code, addresses]).toEqual([
      403,
      "FORBIDDEN",
      [],
    ])
  })

  it("releases the body's project's hold with a main key and replays a second call", async () => {
    mocks.keyAuth.mockResolvedValue(keyOf({ isMain: true, isInternal: false }))
    const holdId = authorize("job-1")
    const body = { projectId: "proj_tenant", key: "customer:acme", holdId }

    const first = await call(body)
    const second = await call(body)

    expect(first.status).toBe(200)
    const released = (await first.json()) as Record<string, unknown>
    expect([released.holdId, released.released, released.replayed]).toEqual([holdId, "5", false])
    expect(released.balance).toMatchObject({ remaining: "50", held: "0" })
    const replayed = (await second.json()) as Record<string, unknown>
    expect([second.status, replayed.released, replayed.replayed]).toEqual([200, "5", true])
    expect(addresses).toEqual([
      { projectId: "proj_tenant", key: "customer:acme" },
      { projectId: "proj_tenant", key: "customer:acme" },
    ])
  })

  it("answers 409 with the rejection for a hold that was settled", async () => {
    mocks.keyAuth.mockResolvedValue(keyOf({ isMain: true, isInternal: false }))
    const holdId = authorize("job-1")
    run({ type: "settle", holdId, amount: BigInt(100_000_000) })

    const response = await call({ projectId: "proj_tenant", key: "customer:acme", holdId })

    expect(response.status).toBe(409)
    expect(await errorOf(response)).toMatchObject({
      code: "CONFLICT",
      message: `Hold ${holdId} is already settled`,
      details: {
        kind: "release_rejected",
        rejection: { code: "HOLD_CLOSED", holdId, status: "settled" },
      },
    })
  })

  it("answers 404 telling a missing hold from a missing budget", async () => {
    mocks.keyAuth.mockResolvedValue(keyOf({ isMain: false, isInternal: true }))

    const hold = await call({ projectId: "proj_tenant", key: "customer:acme", holdId: "h_9" })
    store = new MemoryBudgetStore()
    const budget = await call({ projectId: "proj_tenant", key: "customer:gone", holdId: "h_1" })

    expect([hold.status, (await errorOf(hold)).details]).toEqual([
      404,
      { kind: "release_rejected", rejection: { code: "HOLD_NOT_FOUND", holdId: "h_9" } },
    ])
    expect([budget.status, (await errorOf(budget)).details]).toEqual([
      404,
      { kind: "release_rejected", rejection: { code: "BUDGET_NOT_FOUND" } },
    ])
  })
})
