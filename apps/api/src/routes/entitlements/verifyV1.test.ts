import { OpenAPIHono } from "@hono/zod-openapi"
import { Err, FetchError, Ok } from "@unprice/error"
import { type BudgetSnapshot, UnPriceBudgetError } from "@unprice/services/budgets"
import type { ExecutionContext } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleError, handleZodError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

const mocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
  resolveContextProjectId: vi.fn(),
  execute: vi.fn(),
  getCustomerEntitlementsForCustomer: vi.fn(),
}))

vi.mock("~/auth/key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/auth/key")>()),
  keyAuth: mocks.keyAuth,
  resolveContextProjectId: mocks.resolveContextProjectId,
}))

vi.mock("~/ingestion/budget/client", () => ({
  CloudflareBudgetClient: class {
    execute = mocks.execute
  },
}))

import { registerVerifyV1 } from "./verifyV1"

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const ONE = BigInt(100_000_000)
const NOV = Date.UTC(2026, 10, 1)
const DEC = Date.UTC(2026, 11, 1)

/** A payer budget metering `images` under a hard monthly limit of 10 with `consumed` used. */
function payerBudget(consumed: number, closed = false) {
  const limit = {
    id: "images:month",
    window: "month",
    enforce: "hard",
    measure: { type: "quantity", feature: "images" },
    amount: BigInt(10) * ONE,
    consumed: BigInt(consumed) * ONE,
    held: BigInt(0),
    remaining: BigInt(10 - consumed) * ONE,
    resetsAt: DEC,
  }
  return {
    key: "unprice:customer:cus_a",
    unit: "money:USD",
    closed,
    limits: [{ id: "images:month", window: "month", enforce: "hard", amount: limit.amount }],
    pricing: {
      features: [{ slug: "images", eventSlug: "image.generated", priced: true }],
    },
    balance: { remaining: null, held: { amount: BigInt(0) }, limits: [limit], asOf: NOW },
  } as unknown as BudgetSnapshot
}

const got = (budget: BudgetSnapshot) => Ok({ type: "get", budget, history: [] })

beforeEach(() => {
  mocks.keyAuth.mockResolvedValue({ id: "key_1", projectId: "proj_123", defaultCustomerId: null })
  mocks.resolveContextProjectId.mockImplementation(
    async (_c: unknown, projectId: string) => projectId
  )
  mocks.getCustomerEntitlementsForCustomer.mockResolvedValue(Ok([]))
})

afterEach(() => {
  vi.resetAllMocks()
})

function check(featureSlug: string) {
  const app = new OpenAPIHono<HonoEnv>({ defaultHook: handleZodError })
  app.onError(handleError)
  app.use("*", async (c, next) => {
    c.set("requestId", "req_test")
    c.set("requestStartedAt", NOW)
    c.set("logger", { set: vi.fn() } as unknown as HonoEnv["Variables"]["logger"])
    c.set("services", {
      entitlement: {
        getCustomerEntitlementsForCustomer: mocks.getCustomerEntitlementsForCustomer,
      },
    } as unknown as HonoEnv["Variables"]["services"])
    await next()
  })
  registerVerifyV1(app)
  return app.fetch(
    new Request("https://example.com/v1/access/check", {
      method: "POST",
      headers: { authorization: "Bearer key", "content-type": "application/json" },
      body: JSON.stringify({ customerId: "cus_a", featureSlug }),
    }),
    { APP_ENV: "development" },
    { passThroughOnException: vi.fn(), waitUntil: vi.fn() } as unknown as ExecutionContext
  )
}

describe("POST /v1/access/check", () => {
  it("answers a metered feature from the customer's payer budget", async () => {
    mocks.execute.mockResolvedValue(got(payerBudget(4)))

    const response = await check("images")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      featureSlug: "images",
      allowed: true,
      metered: true,
      usage: 4,
      limit: 10,
      quotaWindow: { periodKey: "images:month", startAt: NOV, endAt: DEC },
    })
    expect(mocks.execute).toHaveBeenCalledWith(
      { projectId: "proj_123", key: "unprice:customer:cus_a" },
      { type: "get" }
    )
    expect(mocks.getCustomerEntitlementsForCustomer).toHaveBeenCalledOnce()
  })

  it("denies a metered feature whose hard limit is used up", async () => {
    mocks.execute.mockResolvedValue(got(payerBudget(10)))

    const response = await check("images")

    expect(await response.json()).toMatchObject({
      allowed: false,
      rejectionReason: "LIMIT_EXCEEDED",
      usage: 10,
      limit: 10,
    })
  })

  it("denies every metered feature once the budget has closed", async () => {
    mocks.execute.mockResolvedValue(got(payerBudget(0, true)))

    expect(await (await check("images")).json()).toMatchObject({
      allowed: false,
      rejectionReason: "BUDGET_CLOSED",
    })
  })

  it("answers a flat feature from the customer's plan when the budget does not meter it", async () => {
    mocks.execute.mockResolvedValue(got(payerBudget(0)))
    mocks.getCustomerEntitlementsForCustomer.mockResolvedValue(
      Ok([
        {
          featurePlanVersion: { featureType: "flat", limit: null, feature: { slug: "sso" } },
          grants: [{ allowanceUnits: 1 }],
        },
      ])
    )

    const response = await check("sso")

    expect(await response.json()).toEqual({
      featureSlug: "sso",
      allowed: true,
      metered: false,
      limit: 1,
      quotaWindow: null,
    })
    expect(mocks.getCustomerEntitlementsForCustomer).toHaveBeenCalledWith({
      customerId: "cus_a",
      projectId: "proj_123",
      now: NOW,
    })
  })

  it("denies a feature the customer does not have, even without a payer budget", async () => {
    mocks.execute.mockResolvedValue(Err(new UnPriceBudgetError({ code: "BUDGET_NOT_FOUND" })))

    expect(await (await check("images")).json()).toEqual({
      featureSlug: "images",
      allowed: false,
      rejectionReason: "NO_ENTITLEMENT",
      metered: false,
      limit: null,
      quotaWindow: null,
    })
  })

  it("maps a failed entitlement read to a 500", async () => {
    mocks.execute.mockResolvedValue(Err(new UnPriceBudgetError({ code: "BUDGET_NOT_FOUND" })))
    mocks.getCustomerEntitlementsForCustomer.mockResolvedValue(
      Err(new FetchError({ message: "database unavailable", retry: true }))
    )

    expect((await check("sso")).status).toBe(500)
  })
})
