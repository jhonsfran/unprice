import { Ok } from "@unprice/error"
import { describe, expect, it } from "vitest"
import { PAYER_HOLDS } from "./compile-payer-budget"
import {
  HttpPayerBudgetGateway,
  type PayerBudgetGateway,
  syncPayerBudgetWithRetry,
} from "./payer-budget-gateway"
import type { SyncPayerBudgetOutput } from "./sync-payer-budget"

const input = { projectId: "proj_1", customerId: "cus_1" }
const key = "unprice:customer:cus_1"
const open: SyncPayerBudgetOutput = { status: "reservations_open", key }
const synced: SyncPayerBudgetOutput = {
  status: "synced",
  key,
  version: 2,
  changes: ["pricing"],
  statements: 1,
}

/** Answers `reservations_open` until `openUntil` on the fake clock, then `synced`. */
function harness(openUntil: number) {
  const clock = { now: 0 }
  const sleeps: number[] = []
  const calls: number[] = []
  const gateway: PayerBudgetGateway = {
    async sync() {
      calls.push(clock.now)
      return Ok(clock.now < openUntil ? open : synced)
    },
    seal: async () => Ok({ sealed: [], open: [] }),
    completeInvoiced: async () => Ok({ completed: [] }),
  }
  const options = {
    now: () => clock.now,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      clock.now += ms
    },
  }
  return { gateway, options, sleeps, calls }
}

describe("syncPayerBudgetWithRetry", () => {
  it("syncs a request once, even while holds are open", async () => {
    const { gateway, options, sleeps } = harness(Number.POSITIVE_INFINITY)
    const result = await syncPayerBudgetWithRetry(gateway, input, { ...options, caller: "request" })
    expect([result.val, sleeps]).toEqual([open, []])
  })

  it("retries a job with backoff until the holds close", async () => {
    const { gateway, options, sleeps } = harness(60_000)
    const result = await syncPayerBudgetWithRetry(gateway, input, { ...options, caller: "job" })
    expect(result.val).toEqual(synced)
    expect(sleeps).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
  })

  it("gives a job up within the longest hold TTL", async () => {
    const { gateway, options, sleeps } = harness(Number.POSITIVE_INFINITY)
    const result = await syncPayerBudgetWithRetry(gateway, input, { ...options, caller: "job" })
    const waited = sleeps.reduce((sum, ms) => sum + ms, 0)
    expect(result.val).toEqual(open)
    expect(waited).toBeLessThanOrEqual(PAYER_HOLDS.maxTtlMs)
    expect(waited + 30_000).toBeGreaterThan(PAYER_HOLDS.maxTtlMs)
  })
})

describe("HttpPayerBudgetGateway", () => {
  it("aborts a sync that outlasts its timeout as a retryable failure", async () => {
    const gateway = new HttpPayerBudgetGateway({
      baseUrl: "https://api.test",
      token: "<API_KEY>",
      timeoutMs: 10,
      fetch: (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")))
        }),
    })

    const result = await gateway.sync(input)
    expect([result.err?.message, result.err?.retry]).toEqual([
      "/v1/internal/payer-budgets/sync timed out after 10 ms",
      true,
    ])
  })

  it("parses both answers of the internal route", async () => {
    for (const body of [synced, open]) {
      const gateway = new HttpPayerBudgetGateway({
        baseUrl: "https://api.test",
        token: "<API_KEY>",
        fetch: async () => Response.json(body),
      })
      expect((await gateway.sync(input)).val).toEqual(body)
    }
  })

  it("posts a seal to its internal route and parses the sealed statements", async () => {
    const requests: Request[] = []
    const answer = {
      sealed: [
        {
          periodId: "events:bp_1",
          billingPeriodId: "bp_1",
          statementKey: "stmt_1",
          featureSlug: "events",
          start: 0,
          end: 10,
          amount: "4200000000",
          quantity: "300000000",
          cost: null,
          events: 3,
        },
      ],
      open: [],
    }
    const gateway = new HttpPayerBudgetGateway({
      baseUrl: "https://api.test/",
      token: "<API_KEY>",
      fetch: async (request) => {
        requests.push(request)
        return Response.json(answer)
      },
    })

    const result = await gateway.seal({ ...input, statementKey: "stmt_1", at: 10 })

    expect(result.val).toEqual(answer)
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.test/v1/internal/payer-budgets/seal",
    ])
  })
})
