import { OpenAPIHono } from "@hono/zod-openapi"
import { Err } from "@unprice/error"
import { type BudgetBalance, UnPriceBudgetError } from "@unprice/services/budgets"
import type { ExecutionContext, MiddlewareHandler } from "hono"
import { type Mock, afterEach, beforeEach, vi } from "vitest"
import { handleError, handleZodError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { registerAuthorizeBudgetV1 } from "./authorizeBudgetV1"
import { registerChargeBudgetV1 } from "./chargeBudgetV1"
import { registerGetBudgetV1 } from "./getBudgetV1"
import { registerLeaseBudgetV1 } from "./leaseBudgetV1"
import { registerModelsBudgetV1 } from "./modelsBudgetV1"
import { registerRecordBudgetV1 } from "./recordBudgetV1"
import { registerReleaseBudgetV1 } from "./releaseBudgetV1"
import { registerReportBudgetV1 } from "./reportBudgetV1"
import { registerSettleBudgetV1 } from "./settleBudgetV1"
import { registerUpsertBudgetV1 } from "./upsertBudgetV1"

const ONE = BigInt(100_000_000)
export const usd = (value: number) => BigInt(value) * ONE

export const balance = (remaining: bigint, held = BigInt(0)): BudgetBalance => ({
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

/** The whole versioned error body the handler emits, so an added or renamed field fails. */
export const errorBody = (code: string, message: string, details?: Record<string, unknown>) => ({
  error: {
    code,
    docs: `https://docs.unprice.dev/api-reference/errors/code/${code}`,
    message,
    requestId: "req_test",
    ...(details ? { details } : {}),
  },
})

export function createBudgetTestFixture(mocks: {
  keyAuth: Mock
  execute: Mock
  log: Mock
  recordCatalog: Mock
}) {
  beforeEach(() => {
    mocks.keyAuth.mockResolvedValue({ id: "key_1", projectId: "proj_123" })
    mocks.recordCatalog.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  /** The request logger, whose `set` fields become the request's wide event. */
  const withLogger: MiddlewareHandler<HonoEnv> = async (c, next) => {
    c.set("logger", { set: mocks.log } as unknown as HonoEnv["Variables"]["logger"])
    c.set("services", {
      budgetCatalog: { record: mocks.recordCatalog },
    } as unknown as HonoEnv["Variables"]["services"])
    c.set("waitUntil", (promise) => void promise)
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
      registerModelsBudgetV1,
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

  return { call, createTestApp, rejectWith, withLogger }
}
