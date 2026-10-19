import { type BudgetConfigInput, upsertBudgetInputSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { catalogFactsOf, catalogStatusOf } from "./index"
import { MemoryBudgetStore } from "./memory-store.fixture"

const t0 = Date.parse("2026-10-14T10:00:00.000Z")

/** The snapshot an upsert of `body` commits on a fresh budget. */
function upserted(body: BudgetConfigInput) {
  const { key, unit, config } = upsertBudgetInputSchema.parse({
    key: "customer:acme",
    unit: "USD",
    ...body,
  })
  const result = new MemoryBudgetStore().run(
    { type: "upsert", key, projectId: "proj_1", unit, config, mayLoosen: true },
    t0
  )
  if (result.err) throw result.err
  if (!result.val.ok || result.val.outcome.type !== "upsert") throw new Error("expected an upsert")
  return result.val.outcome.budget
}

describe("catalogFactsOf", () => {
  it("is hard when any limit is hard, with decimal amounts", () => {
    const budget = upserted({
      limits: [
        { id: "daily", amount: "100", window: "day" },
        { id: "monthly", amount: "2000.5", window: "month", enforce: "soft" },
      ],
    })

    expect(catalogFactsOf(budget)).toEqual({
      key: "customer:acme",
      unit: "money:USD",
      version: 1,
      cap: "hard",
      limits: [
        { id: "daily", window: "day", enforce: "hard", amount: "100" },
        { id: "monthly", window: "month", enforce: "soft", amount: "2000.5" },
      ],
      closesAt: null,
    })
  })

  it("is soft when every limit is soft", () => {
    const budget = upserted({ limits: [{ amount: "5", window: "never", enforce: "soft" }] })

    expect(catalogFactsOf(budget).cap).toBe("soft")
  })

  it("is none without limits, and carries closesAt", () => {
    const closesAt = t0 + 60 * 60 * 1000
    const facts = catalogFactsOf(upserted({ limits: [], closesAt }))

    expect({ cap: facts.cap, limits: facts.limits, closesAt: facts.closesAt }).toEqual({
      cap: "none",
      limits: [],
      closesAt,
    })
  })
})

describe("catalogStatusOf", () => {
  it("is open without closesAt, closing before it, closed from it", () => {
    expect([
      catalogStatusOf(null, t0),
      catalogStatusOf(t0 + 1, t0),
      catalogStatusOf(t0, t0),
    ]).toEqual(["open", "closing", "closed"])
  })
})
