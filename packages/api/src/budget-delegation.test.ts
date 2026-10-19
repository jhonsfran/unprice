import * as Budgets from "@unprice/budgets"
import { describe, expect, it } from "vitest"
import { BudgetExceededError, Unprice } from "./index"

// Budgets live in @unprice/budgets; @unprice/api keeps `unprice.budget()` and `unprice.close()`
// by handing its own transport to that package's handles. These tests pin the delegation: the
// requests go through this client (its headers, base URL and retries), and the errors are the
// same classes, so `instanceof` holds whichever package the caller imports them from.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  })

const balance = { remaining: "9", held: "1", limits: [], asOf: 1_792_000_000_000 }
const terms = { holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 }, closesAt: null }

const clientWith = (respond: (path: string, body: Record<string, unknown>) => Response) => {
  const requests: Array<{ path: string; source: string | null; body: Record<string, unknown> }> = []
  const unprice = new Unprice({
    token: "test-token",
    baseUrl: "https://example.com",
    disableTelemetry: true,
    retry: { attempts: 0 },
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      const body = (await request.json()) as Record<string, unknown>
      requests.push({ path, source: request.headers.get("unprice-request-source"), body })
      return respond(path, body)
    },
  })
  return { unprice, requests }
}

describe("Unprice budgets from @unprice/budgets", () => {
  it("re-exports the budget errors as the same classes", () => {
    expect(BudgetExceededError).toBe(Budgets.BudgetExceededError)
  })

  it("authorizes through this client's transport", async () => {
    const { unprice, requests } = clientWith(() =>
      json({
        allowed: true,
        holdId: "h_1",
        amount: "0.05",
        expiresAt: 1_792_000_060_000,
        replayed: false,
        balance,
      })
    )

    const authorized = await unprice
      .budget("customer:acme")
      .authorize({ amount: "0.05", idempotencyKey: "msg_1" })

    expect(authorized.result).toMatchObject({ allowed: true, hold: { id: "h_1", amount: "0.05" } })
    expect(requests).toEqual([
      {
        path: "/v1/budgets/authorize",
        source: expect.stringMatching(/^sdk@/),
        body: { key: "customer:acme", amount: "0.05", idempotencyKey: "msg_1" },
      },
    ])
  })

  it("throws the re-exported BudgetExceededError when a limit denies a spend", async () => {
    const blocked = {
      limitId: "month",
      window: "month",
      remaining: "0.01",
      held: "0",
      resetsAt: 1_793_491_200_000,
      remedy: "wait_for_reset",
    }
    const { unprice } = clientWith(() =>
      json(
        {
          error: {
            code: "BUDGET_EXCEEDED",
            message: "Budget exceeded",
            docs: "https://docs.unprice.dev/api-reference/errors/code/BUDGET_EXCEEDED",
            requestId: "req_1",
            details: { kind: "budget_exceeded", blocked, balance },
          },
        },
        402
      )
    )

    const spent = unprice
      .budget("customer:acme")
      .spend({ estimate: "1" }, async () => ({ value: "never", actual: "0" }))

    await expect(spent).rejects.toBeInstanceOf(BudgetExceededError)
  })

  it("returns a local lease on close", async () => {
    const view = (leaseKey: string, captured: string, status: "open" | "closed") => ({
      leaseKey,
      seq: status === "open" ? 0 : 1,
      granted: "1",
      captured,
      expiresAt: 1_792_000_060_000,
      status,
    })
    const { unprice, requests } = clientWith((path, body) => {
      const leaseKey = String(body.leaseKey)
      return path.endsWith("/lease")
        ? json({ lease: view(leaseKey, "0", "open"), terms, replayed: false, balance })
        : json({
            lease: view(leaseKey, String(body.captured ?? "0"), "closed"),
            terms,
            extension: { requested: "0", granted: "0" },
            released: "1",
            crossed: [],
            replayed: false,
            balance,
          })
    })

    const local = unprice.budget("customer:acme", { mode: "local", lease: { amount: "1" } })
    await local
      .authorize({ amount: "0.05", idempotencyKey: "msg_1" })
      .then((authorized) =>
        authorized.result?.allowed ? authorized.result.hold.release() : undefined
      )

    expect(await unprice.close()).toEqual([])
    expect(requests.map((request) => request.path)).toEqual([
      "/v1/budgets/lease",
      "/v1/budgets/report",
    ])
  })
})
