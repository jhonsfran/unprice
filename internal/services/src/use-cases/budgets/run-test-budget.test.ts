import { Err, FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import {
  type RunTestBudgetDeps,
  TEST_BUDGET_API_KEY_NAME,
  TEST_BUDGET_KEY,
  runTestBudget,
} from "./run-test-budget"

const NOW = Date.UTC(2026, 9, 28, 15, 0, 0)

function createLogger(): Logger {
  return { set: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger
}

const balance = (remaining: string) => ({ remaining, held: "0", limits: [] })

const exceeded = {
  code: "BUDGET_EXCEEDED" as const,
  message: "The day limit of 10 USD leaves 6 USD; 8 USD does not fit",
  docs: "https://docs.unprice.dev",
  requestId: "req_1",
  details: { kind: "budget_exceeded", blocked: {}, balance: balance("6") },
}

function createDeps(overrides?: {
  denied?: unknown
  createOrRollApiKey?: ReturnType<typeof vi.fn>
}) {
  const upsert = vi.fn().mockResolvedValue({ result: { changes: [], budget: {} } })
  const charge = vi
    .fn()
    .mockResolvedValueOnce({
      result: {
        allowed: true,
        amount: "4",
        crossed: [],
        replayed: false,
        balance: balance("6"),
        created: false,
      },
    })
    .mockResolvedValueOnce(overrides?.denied ?? { error: exceeded })
  const createOrRollApiKey =
    overrides?.createOrRollApiKey ??
    vi.fn().mockResolvedValue(Ok({ id: "apikey_1", key: "unprice_live_secret", state: "created" }))
  const createApiClient = vi.fn().mockReturnValue({ budgets: { upsert, charge } })

  const deps = {
    services: { apikeys: { createOrRollApiKey } },
    logger: createLogger(),
    createApiClient,
  } as unknown as RunTestBudgetDeps

  return { deps, upsert, charge, createOrRollApiKey, createApiClient }
}

describe("runTestBudget", () => {
  it("creates the sandbox budget with a runtime key and shows one allowed and one denied spend", async () => {
    const { deps, upsert, charge, createOrRollApiKey, createApiClient } = createDeps()

    const result = await runTestBudget(deps, { projectId: "proj_1", now: NOW })

    expect(result.err).toBeUndefined()
    expect(createOrRollApiKey).toHaveBeenCalledWith({
      projectId: "proj_1",
      name: TEST_BUDGET_API_KEY_NAME,
      isRoot: false,
      defaultCustomerId: null,
      expiresAt: NOW + 60 * 60 * 1000,
    })
    expect(createApiClient).toHaveBeenCalledWith("unprice_live_secret")
    expect(upsert).toHaveBeenCalledWith({
      key: TEST_BUDGET_KEY,
      unit: "USD",
      limits: [{ amount: "10", window: "day" }],
    })
    expect(charge).toHaveBeenNthCalledWith(1, {
      key: TEST_BUDGET_KEY,
      amount: "4",
      idempotencyKey: "test-budget:2026-10-28:allowed",
    })
    expect(charge).toHaveBeenNthCalledWith(2, {
      key: TEST_BUDGET_KEY,
      amount: "8",
      idempotencyKey: "test-budget:2026-10-28:denied",
    })
    expect(result.val).toEqual({
      key: TEST_BUDGET_KEY,
      unit: "USD",
      cap: "10",
      window: "day",
      allowed: { amount: "4", remaining: "6" },
      denied: {
        amount: "8",
        status: 402,
        code: "BUDGET_EXCEEDED",
        message: exceeded.message,
        remaining: "6",
      },
    })
  })

  it("fails when the spend over the cap is allowed", async () => {
    const { deps } = createDeps({
      denied: {
        result: {
          allowed: true,
          amount: "8",
          crossed: [],
          replayed: false,
          balance: balance("0"),
          created: false,
        },
      },
    })

    const result = await runTestBudget(deps, { projectId: "proj_1", now: NOW })

    expect(result.err?.message).toContain("cap did not hold")
  })

  it("fails on a denial that is not the cap", async () => {
    const { deps } = createDeps({
      denied: { error: { code: "FORBIDDEN", message: "nope", docs: "", requestId: "req_2" } },
    })

    const result = await runTestBudget(deps, { projectId: "proj_1", now: NOW })

    expect(result.err?.message).toContain("second test spend failed: nope")
  })

  it("stops before calling the API when the test key cannot be created", async () => {
    const { deps, createApiClient } = createDeps({
      createOrRollApiKey: vi
        .fn()
        .mockResolvedValue(Err(new FetchError({ message: "db down", retry: false }))),
    })

    const result = await runTestBudget(deps, { projectId: "proj_1", now: NOW })

    expect(result.err?.message).toContain("Test key setup failed: db down")
    expect(createApiClient).not.toHaveBeenCalled()
  })
})
