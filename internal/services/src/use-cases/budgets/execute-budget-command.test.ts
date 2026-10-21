import {
  type BudgetConfigInput,
  authorizeBudgetInputSchema,
  chargeBudgetInputSchema,
  leaseBudgetInputSchema,
  upsertBudgetInputSchema,
} from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it } from "vitest"
import type { BudgetCatalogService } from "../../budget-catalog"
import { type BudgetCatalogFacts, UnPriceBudgetError } from "../../budgets"
import { MemoryBudgetStore } from "../../budgets/memory-store.fixture"
import type { BudgetClient } from "./budget-client"
import {
  type BudgetVerbRequest,
  type ExecuteBudgetCommandDeps,
  executeBudgetCommand,
} from "./execute-budget-command"

const t0 = Date.parse("2026-10-14T10:00:00.000Z")

function harness(record?: (facts: BudgetCatalogFacts) => Promise<void>) {
  const store = new MemoryBudgetStore()
  const budgets: BudgetClient = {
    async execute(_address, request) {
      const result = store.run(request, t0)
      if (result.err) return result
      if (!result.val.ok) return Err(new UnPriceBudgetError(result.val.rejection))
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
  const deps: ExecuteBudgetCommandDeps = {
    budgets,
    services: { budgetCatalog },
    waitUntil: (promise) => void pending.push(promise),
    logger,
  }
  const execute = <R extends BudgetVerbRequest>(request: R) =>
    executeBudgetCommand(deps, { projectId: "proj_1", key: "customer:acme", request })
  const flush = () => Promise.all(pending.splice(0))

  const upsert = async (body: BudgetConfigInput & { unit?: string }) => {
    const { unit, config } = upsertBudgetInputSchema.parse({
      key: "customer:acme",
      unit: "USD",
      ...body,
    })
    const result = await execute({ type: "upsert", unit, config, mayLoosen: true })
    await flush()
    return result
  }

  return { execute, upsert, written, errors, flush, deps }
}

const daily100 = { limits: [{ id: "daily", amount: "100", window: "day" as const }] }

describe("executeBudgetCommand", () => {
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

  it("records an upsert replay while the budget is still at version 1", async () => {
    const { upsert, written } = harness()
    await upsert(daily100)

    const replay = await upsert(daily100)

    expect({ changes: replay.val?.changes, version: replay.val?.budget.version }).toEqual({
      changes: [],
      version: 1,
    })
    expect(written.map(({ facts }) => facts.version)).toEqual([1, 1])
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

  const ifMissing = { unit: "USD", ...daily100 }
  const firstUseRequest = (type: "authorize" | "charge" | "lease", amount = "1") => {
    const body = { key: "customer:acme", amount, ifMissing }
    if (type === "lease") {
      const { key: _, ...request } = leaseBudgetInputSchema.parse({
        ...body,
        leaseKey: "first",
        ttlMs: 60_000,
      })
      return { type, ...request }
    }
    const schema = type === "authorize" ? authorizeBudgetInputSchema : chargeBudgetInputSchema
    const { key: _, ...request } = schema.parse({ ...body, idempotencyKey: "first" })
    return { type, ...request }
  }

  it.each(["authorize", "charge", "lease"] as const)(
    "records a budget created by %s only on the first call",
    async (type) => {
      const { execute, written, flush } = harness()
      const request = firstUseRequest(type)

      const created = await execute(request)
      const replay = await execute(request)
      await flush()

      expect(created.val).toMatchObject({
        type,
        replayed: false,
        created: { key: "customer:acme", unit: "money:USD", version: 1 },
      })
      expect(replay.val).toMatchObject({ type, replayed: true, created: null })
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
    }
  )

  it("records nothing when the first call is rejected", async () => {
    const { execute, written, flush } = harness()

    const result = await execute(firstUseRequest("authorize", "101"))
    await flush()

    expect(result.err?.rejection).toMatchObject({ code: "LIMIT_EXCEEDED" })
    expect(written).toEqual([])
  })

  it("returns the outcome before the catalog write finishes", async () => {
    let finishWrite = () => {}
    const { execute, written, flush } = harness(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        })
    )

    const result = await execute(firstUseRequest("authorize"))

    expect(result.val).toMatchObject({ type: "authorize", holdId: "h_1" })
    expect(written.map(({ facts }) => facts.version)).toEqual([1])
    finishWrite()
    await flush()
  })

  it("answers a creating verb and logs a non-Error catalog failure", async () => {
    const { execute, errors, flush } = harness(() => Promise.reject("connection reset"))

    const result = await execute(firstUseRequest("charge"))
    await flush()

    expect(result.val).toMatchObject({ type: "charge", created: { version: 1 } })
    expect(errors).toEqual([
      {
        message: "connection reset",
        fields: { context: "budget catalog write failed", projectId: "proj_1", version: 1 },
      },
    ])
  })

  it("rejects an outcome for another command before recording catalog facts", async () => {
    const { execute, upsert, deps, written } = harness()
    const upserted = await upsert(daily100)
    written.length = 0
    deps.budgets = {
      async execute() {
        return upserted
      },
    }

    await expect(execute(firstUseRequest("authorize"))).rejects.toThrow(
      "budget authorize returned a upsert outcome"
    )
    expect(written).toEqual([])
  })
})
