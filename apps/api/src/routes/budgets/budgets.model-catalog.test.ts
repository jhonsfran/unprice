import { describe, expect, it, vi } from "vitest"
import { createBudgetTestFixture } from "./budgets.fixture"

const mocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
  execute: vi.fn(),
  log: vi.fn(),
  recordCatalog: vi.fn(),
}))

vi.mock("~/auth/key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/auth/key")>()),
  keyAuth: mocks.keyAuth,
}))

vi.mock("~/ingestion/budget/client", () => ({
  CloudflareBudgetClient: class {
    execute = mocks.execute
  },
}))

const { call } = createBudgetTestFixture(mocks)

describe("budget model catalog", () => {
  it("answers the rows of the requested ids, in request order, without touching a budget", async () => {
    const response = await call(
      `/v1/budgets/models?ids=${encodeURIComponent("nope/x,openai/gpt-5,anthropic/claude-sonnet-4-5,openai/gpt-5")}`
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      version: string
      models: Array<{ id: string; provider: string; model: string; unit: string; per: number }>
    }
    expect(body.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.models.map((row) => row.id)).toEqual([
      "openai/gpt-5",
      "anthropic/claude-sonnet-4-5",
    ])
    expect(body.models[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      unit: "money:USD",
      per: 1_000_000,
    })
    expect(mocks.keyAuth).toHaveBeenCalledTimes(1)
    expect(mocks.execute).toHaveBeenCalledTimes(0)
  })

  it("answers an empty list for ids the catalog does not know", async () => {
    const response = await call("/v1/budgets/models?ids=nope%2Fx")
    expect(response.status).toBe(200)
    expect(((await response.json()) as { models: unknown[] }).models).toEqual([])
  })

  it("returns 400 without ids", async () => {
    expect((await call("/v1/budgets/models")).status).toBe(400)
    expect((await call("/v1/budgets/models?ids=")).status).toBe(400)
  })
})
