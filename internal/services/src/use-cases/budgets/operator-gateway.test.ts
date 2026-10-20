import type { InspectBudgetResponse } from "@unprice/db/validators"
import { FetchError } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { UnPriceBudgetError } from "../../budgets"
import { HttpBudgetOperatorGateway } from "./operator-gateway"

const inspection: InspectBudgetResponse = {
  budget: {
    key: "customer:acme",
    unit: "money:USD",
    version: 2,
    limits: [{ id: "day", amount: "100", window: "day", enforce: "hard" }],
    holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
    onUnavailable: "deny",
    closesAt: null,
    closed: false,
    balance: {
      remaining: "95",
      held: "5",
      limits: [
        {
          id: "day",
          window: "day",
          enforce: "hard",
          amount: "100",
          consumed: "0",
          held: "5",
          remaining: "95",
          resetsAt: 1_796_169_600_000,
        },
      ],
      asOf: 1_796_083_200_000,
    },
    operations: {
      upsert: 2,
      authorize: 1,
      settle: 0,
      release: 0,
      charge: 0,
      record: 0,
      lease: 0,
      report: 0,
    },
  },
  history: [],
  expiringNext: {
    rows: [
      {
        kind: "hold",
        id: "h_1",
        idempotencyKey: "job-1",
        amount: "5",
        ttlMs: null,
        createdAt: 1_796_083_100_000,
        expiresAt: 1_796_084_000_000,
        state: { status: "open" },
      },
    ],
    examined: 1,
    next: null,
  },
  listed: "5",
  closedRecently: [],
}

const input = { projectId: "proj_1", key: "customer:acme", probe: "2" }

function gateway(response: Response | Error) {
  const fetch = vi.fn(async (_request: Request) => {
    if (response instanceof Error) throw response
    return response
  })
  return {
    fetch,
    gateway: new HttpBudgetOperatorGateway({
      baseUrl: "https://api.example.test/",
      token: "test_token",
      fetch,
    }),
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("HttpBudgetOperatorGateway.inspect", () => {
  it("posts the request to the internal route with bearer auth and parses the inspection", async () => {
    const { fetch, gateway: client } = gateway(json(inspection))

    const result = await client.inspect(input)

    expect(result.val).toEqual(inspection)
    const request = fetch.mock.calls[0]?.[0]
    expect([request?.method, request?.url, request?.headers.get("authorization")]).toEqual([
      "POST",
      "https://api.example.test/v1/internal/budgets/inspect",
      "Bearer test_token",
    ])
    await expect(request?.json()).resolves.toEqual(input)
  })

  it("reads the API's 404 as a missing budget", async () => {
    const { gateway: client } = gateway(
      json({ error: { code: "NOT_FOUND", message: "Budget does not exist" } }, 404)
    )

    const result = await client.inspect(input)

    expect(result.err).toBeInstanceOf(UnPriceBudgetError)
    expect(result.err && "rejection" in result.err && result.err.rejection).toEqual({
      code: "BUDGET_NOT_FOUND",
    })
  })

  it("does not read a bare 404 from a host without the route as a missing budget", async () => {
    const { gateway: client } = gateway(new Response("404 Not Found", { status: 404 }))

    const result = await client.inspect(input)

    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.retry).toBe(false)
  })

  it("answers a retryable FetchError for a 500 and for a network failure", async () => {
    const failed = await gateway(
      json({ error: { code: "INTERNAL_SERVER_ERROR", message: "object reset" } }, 500)
    ).gateway.inspect(input)
    const unreachable = await gateway(new Error("network down")).gateway.inspect(input)

    expect(failed.err).toBeInstanceOf(FetchError)
    expect([failed.err?.message, failed.err?.retry]).toEqual(["object reset", true])
    expect(unreachable.err).toBeInstanceOf(FetchError)
    expect([unreachable.err?.message, unreachable.err?.retry]).toEqual(["network down", true])
  })

  it("rejects a 200 whose body is not an inspection", async () => {
    const result = await gateway(json({ budget: null })).gateway.inspect(input)

    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.retry).toBe(false)
  })
})
