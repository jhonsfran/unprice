import { OpenAPIHono } from "@hono/zod-openapi"
import type { RecordUsageResponse } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import { budgetJournalRowSchema } from "@unprice/lakehouse"
import { type BudgetRejection, UnPriceBudgetError, amountUsage } from "@unprice/services/budgets"
import type { BudgetRequest } from "@unprice/services/use-cases"
import type { ExecutionContext } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleError, handleZodError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { balance, errorBody, usd } from "../budgets/budgets.fixture"

const mocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
  resolveContextProjectId: vi.fn(),
  execute: vi.fn(),
  bouncer: vi.fn(),
  journal: vi.fn(),
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

vi.mock("~/util/bouncer", () => ({ bouncer: mocks.bouncer }))

import { registerConsumeUsageV1 } from "./consumeUsageV1"
import { registerRecordUsageV1 } from "./recordUsageV1"

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

const charged = (amount: bigint, replayed = false) =>
  Ok({
    type: "charge",
    usage: amountUsage(amount),
    crossed: [],
    replayed,
    balance: balance(usd(40)),
    created: null,
  })

const recorded = (amount: bigint, replayed = false, crossed: string[] = []) =>
  Ok({
    type: "record",
    usage: amountUsage(amount),
    crossed,
    replayed,
    balance: balance(usd(40)),
    created: null,
  })

const rejected = (rejection: BudgetRejection) => Err(new UnPriceBudgetError(rejection))

beforeEach(() => {
  mocks.keyAuth.mockResolvedValue({
    id: "key_1",
    projectId: "proj_123",
    defaultCustomerId: null,
  })
  mocks.resolveContextProjectId.mockImplementation(
    async (_c: unknown, projectId: string) => projectId
  )
  mocks.bouncer.mockResolvedValue(undefined)
  mocks.journal.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.resetAllMocks()
})

function createApp() {
  const pending: Promise<unknown>[] = []
  const logged: Record<string, unknown>[] = []
  const app = new OpenAPIHono<HonoEnv>({ defaultHook: handleZodError })
  app.onError(handleError)
  app.use("*", async (c, next) => {
    c.set("requestId", "req_test")
    c.set("requestStartedAt", NOW)
    c.set("logger", {
      set: (fields: Record<string, unknown>) => logged.push(fields),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as HonoEnv["Variables"]["logger"])
    c.set("services", {
      budgetCatalog: { record: vi.fn() },
      rateCards: { getCard: vi.fn() },
      wallet: {},
    } as unknown as HonoEnv["Variables"]["services"])
    c.set("waitUntil", (promise) => void pending.push(promise))
    await next()
  })
  registerRecordUsageV1(app)
  registerConsumeUsageV1(app)

  const call = (path: string, body: unknown) =>
    app.fetch(
      new Request(`https://example.com${path}`, {
        method: "POST",
        headers: { authorization: "Bearer key", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { APP_ENV: "development", PIPELINE_BUDGET_JOURNAL: { send: mocks.journal } },
      { passThroughOnException: vi.fn(), waitUntil: vi.fn() } as unknown as ExecutionContext
    )
  return { call, flush: () => Promise.all(pending.splice(0)), logged }
}

const recordEvent = (idempotencyKey: string, customerId: string | null = "cus_a") => ({
  idempotencyKey,
  eventSlug: "image.generated",
  occurredAt: NOW - 60_000,
  properties: { size: "1024" },
  ...(customerId && { customerId }),
})

/** The commands the budget saw, as [key, command]. */
const sent = () =>
  mocks.execute.mock.calls.map((call) => {
    const [address, request] = call as [{ key: string }, BudgetRequest]
    return [address.key, request]
  })

describe("POST /v1/usage/record", () => {
  it("records each event in its customer's payer budget and answers per event", async () => {
    mocks.execute.mockResolvedValueOnce(recorded(usd(1), false, ["images:month"]))
    mocks.execute.mockResolvedValueOnce(recorded(BigInt(4_000_000)))
    // A key bound to a customer fills in an event's missing customerId.
    mocks.keyAuth.mockResolvedValue({
      id: "key_1",
      projectId: "proj_123",
      defaultCustomerId: "cus_default",
    })
    const { call } = createApp()

    const response = await call("/v1/usage/record", {
      events: [recordEvent("e1", "cus_default"), recordEvent("e2", null)],
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      accepted: 2,
      rejected: 0,
      results: [
        {
          status: "accepted",
          customerId: "cus_default",
          idempotencyKey: "e1",
          amount: "1",
          crossed: ["images:month"],
          replayed: false,
        },
        {
          status: "accepted",
          customerId: "cus_default",
          idempotencyKey: "e2",
          amount: "0.04",
          crossed: [],
          replayed: false,
        },
      ],
    })
    expect(mocks.execute.mock.calls.map(([address]) => address)).toEqual([
      { projectId: "proj_123", key: "unprice:customer:cus_default" },
      { projectId: "proj_123", key: "unprice:customer:cus_default" },
    ])
    expect(sent()[0]?.[1]).toEqual({
      type: "record",
      idempotencyKey: "e1",
      occurredAt: NOW - 60_000,
      event: { slug: "image.generated", properties: { size: "1024" } },
    })
  })

  it("answers a replayed event with the first answer and replayed: true", async () => {
    mocks.execute.mockResolvedValue(recorded(BigInt(4_000_000), true))
    const { call } = createApp()

    const response = await call("/v1/usage/record", { events: [recordEvent("e1")] })

    expect(((await response.json()) as RecordUsageResponse).results).toEqual([
      expect.objectContaining({ status: "accepted", amount: "0.04", replayed: true }),
    ])
  })

  it.each([
    [{ code: "NOT_PRICED", feature: "images", match: { size: "2048" } }, "BAD_REQUEST", 400],
    [{ code: "UNKNOWN_EVENT", slug: "image.generated" }, "BAD_REQUEST", 400],
    [
      { code: "INVALID_OCCURRED_AT", occurredAt: NOW + 3_600_000, latestAccepted: NOW },
      "BAD_REQUEST",
      400,
    ],
    [
      { code: "TOO_LATE", occurredAt: NOW - 90_000_000, oldestAccepted: NOW - 86_400_000 },
      "CONFLICT",
      409,
    ],
    [
      { code: "PERIOD_CLOSED", featureSlug: "images", at: NOW, periodId: "images:bp_oct" },
      "CONFLICT",
      409,
    ],
    [{ code: "NO_STATEMENT", featureSlug: "images", at: NOW }, "CONFLICT", 409],
    [{ code: "IDEMPOTENCY_CONFLICT", idempotencyKey: "e1" }, "CONFLICT", 409],
    [{ code: "BUDGET_NOT_FOUND" }, "NOT_FOUND", 404],
  ] as const)(
    "maps a %j refusal to the error a single call returns",
    async (rejection, code, status) => {
      mocks.execute.mockResolvedValue(rejected(rejection as BudgetRejection))
      const { call, flush } = createApp()

      const response = await call("/v1/usage/record", { events: [recordEvent("e1")] })
      await flush()

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        accepted: 0,
        rejected: 1,
        results: [
          {
            status: "rejected",
            customerId: "cus_a",
            idempotencyKey: "e1",
            error: { code, status, reason: rejection.code, message: expect.any(String) },
          },
        ],
      })
    }
  )

  it("answers a batch of 100 with mixed results and journals each refusal", async () => {
    const refusals: Record<number, BudgetRejection> = {
      7: { code: "NOT_PRICED", feature: "images", match: { size: "2048" } },
      21: { code: "TOO_LATE", occurredAt: NOW - 90_000_000, oldestAccepted: NOW - 86_400_000 },
      42: { code: "UNKNOWN_EVENT", slug: "chat.sent" },
      99: { code: "BUDGET_NOT_FOUND" },
    }
    mocks.execute.mockImplementation(async (_address, request: BudgetRequest) => {
      const n = Number((request as { idempotencyKey: string }).idempotencyKey.slice(1))
      const refusal = refusals[n]
      if (refusal) return rejected(refusal)
      return recorded(BigInt(4_000_000), n === 50)
    })
    const { call, flush, logged } = createApp()
    const events = Array.from({ length: 100 }, (_, n) =>
      recordEvent(`e${n}`, n === 99 ? "cus_new" : n % 2 === 0 ? "cus_a" : "cus_b")
    )

    const response = await call("/v1/usage/record", { events })
    await flush()
    const body = (await response.json()) as RecordUsageResponse

    expect(response.status).toBe(200)
    expect(body.accepted).toBe(96)
    expect(body.rejected).toBe(4)
    expect(body.results.map((result) => result.idempotencyKey)).toEqual(
      events.map((event) => event.idempotencyKey)
    )
    expect(
      body.results.flatMap((result, n) =>
        result.status === "rejected" ? [[n, result.error.reason]] : []
      )
    ).toEqual([
      [7, "NOT_PRICED"],
      [21, "TOO_LATE"],
      [42, "UNKNOWN_EVENT"],
      [99, "BUDGET_NOT_FOUND"],
    ])
    expect(body.results[50]).toMatchObject({ status: "accepted", replayed: true })
    expect(mocks.execute).toHaveBeenCalledTimes(100)
    const rows = mocks.journal.mock.calls.flatMap(([batch]) => batch)
    expect(rows.map((row) => budgetJournalRowSchema.parse(row).operation_id)).toEqual([
      "r:e7",
      "r:e21",
      "r:e42",
      "r:e99",
    ])
    expect(rows[3]).toMatchObject({
      project_id: "proj_123",
      budget_key: "unprice:customer:cus_new",
      seq: 0,
      kind: "record",
      status: "rejected",
      timestamp: new Date(NOW).toISOString(),
    })
    expect(logged).toContainEqual({
      usage: { verb: "record", events: 100, rejected: 4, customers: 3 },
    })
  })

  it("refuses more than 100 events, an event without occurredAt, and nested properties", async () => {
    const { call } = createApp()
    const tooMany = Array.from({ length: 101 }, (_, n) => recordEvent(`e${n}`))
    const { occurredAt: _, ...untimed } = recordEvent("e1")

    for (const body of [
      { events: tooMany },
      { events: [] },
      { events: [untimed] },
      { events: [{ ...recordEvent("e1"), properties: { nested: { size: "1024" } } }] },
    ]) {
      const response = await call("/v1/usage/record", body)
      expect(response.status).toBe(400)
    }
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it("refuses a body over 512 KB before parsing it", async () => {
    const { call } = createApp()
    const big = recordEvent("e1")
    const response = await call("/v1/usage/record", {
      events: [{ ...big, properties: { blob: "x".repeat(1024) } }],
      padding: "x".repeat(600 * 1024),
    })

    expect(response.status).toBe(413)
    expect(mocks.execute).not.toHaveBeenCalled()
  })
})

describe("POST /v1/usage/consume", () => {
  const consumeEvent = {
    customerId: "cus_a",
    idempotencyKey: "c1",
    eventSlug: "image.generated",
    properties: { size: "1024" },
  }

  it("charges the event in the payer budget and returns what it cost", async () => {
    mocks.execute.mockResolvedValue(charged(BigInt(4_000_000)))
    const { call } = createApp()

    const response = await call("/v1/usage/consume", consumeEvent)

    expect(response.status).toBe(200)
    expect(response.headers.get("Unprice-Budget-Remaining")).toBe("40")
    expect(await response.json()).toEqual({
      allowed: true,
      customerId: "cus_a",
      amount: "0.04",
      crossed: [],
      replayed: false,
      balance: expect.objectContaining({ remaining: "40" }),
    })
    expect(sent()).toEqual([
      [
        "unprice:customer:cus_a",
        {
          type: "charge",
          idempotencyKey: "c1",
          event: { slug: "image.generated", properties: { size: "1024" } },
        },
      ],
    ])
    expect(mocks.bouncer).toHaveBeenCalledWith(expect.anything(), "cus_a", "proj_123")
  })

  it("replays an idempotent repeat", async () => {
    mocks.execute.mockResolvedValue(charged(BigInt(4_000_000), true))
    const { call } = createApp()

    const response = await call("/v1/usage/consume", consumeEvent)

    expect(await response.json()).toMatchObject({ allowed: true, replayed: true, amount: "0.04" })
  })

  it("denies past a hard limit with 402 and the blocking limit", async () => {
    const blocked = {
      limitId: "images:month",
      window: "month" as const,
      remaining: BigInt(0),
      held: BigInt(0),
      resetsAt: 1_798_761_600_000,
      remedy: "wait_for_reset" as const,
    }
    mocks.execute.mockResolvedValue(
      rejected({ code: "LIMIT_EXCEEDED", blocked, balance: balance(BigInt(0)) })
    )
    const { call, flush } = createApp()

    const response = await call("/v1/usage/consume", consumeEvent)
    await flush()

    expect(response.status).toBe(402)
    expect(await response.json()).toMatchObject({
      error: {
        code: "BUDGET_EXCEEDED",
        details: { kind: "budget_exceeded", blocked: { limitId: "images:month", remaining: "0" } },
      },
    })
    expect(mocks.journal).toHaveBeenCalledWith([
      expect.objectContaining({ operation_id: "r:c1", kind: "charge", status: "rejected" }),
    ])
  })

  it("denies with 402 when the prepaid wallet cannot fund the event", async () => {
    mocks.execute.mockResolvedValue(
      rejected({
        code: "WALLET_EMPTY",
        statementKey: "inv_nov",
        required: usd(1),
        available: BigInt(0),
      })
    )
    const { call } = createApp()

    const response = await call("/v1/usage/consume", consumeEvent)

    expect(response.status).toBe(402)
    expect(await response.json()).toEqual(
      errorBody("BUDGET_EXCEEDED", "The wallet cannot fund 1 more usage on this budget")
    )
  })

  it("returns 400 for an event no rate prices", async () => {
    mocks.execute.mockResolvedValue(
      rejected({ code: "NOT_PRICED", feature: "images", match: { size: "2048" } })
    )
    const { call } = createApp()

    const response = await call("/v1/usage/consume", consumeEvent)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } })
  })

  it("refuses a disabled customer before the budget", async () => {
    const { UnpriceApiError } = await import("~/errors")
    mocks.bouncer.mockRejectedValue(new UnpriceApiError({ code: "FORBIDDEN", message: "disabled" }))
    const { call } = createApp()

    const response = await call("/v1/usage/consume", consumeEvent)

    expect(response.status).toBe(403)
    expect(mocks.execute).not.toHaveBeenCalled()
  })
})
