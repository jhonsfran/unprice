import { type BudgetConfigInput, upsertBudgetInputSchema } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it } from "vitest"
import type { BudgetCatalogService } from "../../budget-catalog"
import type { BudgetCatalogFacts } from "../../budgets"
import { MemoryBudgetStore } from "../../budgets/memory-store.fixture"
import type { BudgetClient } from "./budget-client"
import { upsertBudget } from "./upsert-budget"

const t0 = Date.parse("2026-10-14T10:00:00.000Z")

function harness(record?: (facts: BudgetCatalogFacts) => Promise<void>) {
  const store = new MemoryBudgetStore()
  const budgets: BudgetClient = {
    async execute(_address, request) {
      const result = store.run(request, t0)
      if (result.err) return result
      if (!result.val.ok) throw new Error("an upsert is never refused")
      return Ok(result.val.outcome)
    },
  }
  const written: { projectId: string; facts: BudgetCatalogFacts }[] = []
  const budgetCatalog = {
    async record(projectId: string, facts: BudgetCatalogFacts) {
      written.push({ projectId, facts })
      await record?.(facts)
    },
  } as unknown as BudgetCatalogService
  const pending: Promise<unknown>[] = []
  const errors: { message: string; fields: unknown }[] = []
  const logger = {
    error: (error: Error, fields: unknown) => errors.push({ message: error.message, fields }),
  } as unknown as Logger

  const upsert = async (body: BudgetConfigInput & { unit?: string }) => {
    const { key, unit, config } = upsertBudgetInputSchema.parse({
      key: "customer:acme",
      unit: "USD",
      ...body,
    })
    const result = await upsertBudget(
      { budgets, services: { budgetCatalog }, waitUntil: (p) => pending.push(p), logger },
      { projectId: "proj_1", key, request: { type: "upsert", unit, config, mayLoosen: true } }
    )
    await Promise.all(pending.splice(0))
    return result
  }

  return { upsert, written, errors }
}

const daily100 = { limits: [{ id: "daily", amount: "100", window: "day" as const }] }

describe("upsertBudget", () => {
  it("records the created budget's facts once", async () => {
    const { upsert, written } = harness()

    const result = await upsert(daily100)

    expect(result.val?.budget.version).toBe(1)
    expect(written).toEqual([
      {
        projectId: "proj_1",
        facts: {
          key: "customer:acme",
          unit: "money:USD",
          version: 1,
          cap: "hard",
          limits: [{ id: "daily", window: "day", enforce: "hard", amount: "100" }],
          closesAt: null,
        },
      },
    ])
  })

  it("records nothing for a replay of a changed budget", async () => {
    const { upsert, written } = harness()
    await upsert(daily100)
    await upsert({ limits: [{ id: "daily", amount: "50", window: "day" }] })

    const replay = await upsert({ limits: [{ id: "daily", amount: "50", window: "day" }] })

    expect({ changes: replay.val?.changes, version: replay.val?.budget.version }).toEqual({
      changes: [],
      version: 2,
    })
    expect(written.map(({ facts }) => facts.version)).toEqual([1, 2])
  })

  it("records a budget created without limits, whose changes are empty", async () => {
    const { upsert, written } = harness()

    const result = await upsert({ limits: [] })

    expect(result.val?.changes).toEqual([])
    expect(written.map(({ facts }) => [facts.version, facts.cap])).toEqual([[1, "none"]])
  })

  it("records nothing and returns the rejection when the budget refuses", async () => {
    const { upsert, written } = harness()
    await upsert(daily100)

    const result = await upsert({ ...daily100, unit: "EUR" })

    expect(result.err?.rejection.code).toBe("UNIT_IMMUTABLE")
    expect(written.map(({ facts }) => facts.unit)).toEqual(["money:USD"])
  })

  it("answers the upsert and logs when the catalog write fails", async () => {
    const { upsert, errors } = harness(() => Promise.reject(new Error("connection reset")))

    const result = await upsert(daily100)

    expect(result.val?.budget.version).toBe(1)
    expect(errors).toEqual([
      {
        message: "connection reset",
        fields: { context: "budget catalog write failed", projectId: "proj_1", version: 1 },
      },
    ])
  })
})
