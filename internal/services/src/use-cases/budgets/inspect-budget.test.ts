import type {
  BudgetCatalogFacts,
  BudgetCatalogRow,
  InspectBudgetRequest,
  InspectBudgetResponse,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it } from "vitest"
import type { BudgetCatalogService } from "../../budget-catalog"
import { UnPriceBudgetError } from "../../budgets"
import { inspectBudget } from "./inspect-budget"
import { openBudgetByKey } from "./open-budget-by-key"
import type { BudgetOperatorGateway } from "./operator-gateway"

const row: BudgetCatalogRow = {
  id: "bgt_1",
  key: "customer:acme",
  unit: "money:USD",
  version: 2,
  cap: "hard",
  limits: [{ id: "day", window: "day", enforce: "hard", amount: "100" }],
  closesAt: null,
  status: "open",
  createdAt: 1_796_000_000_000,
  updatedAt: 1_796_000_000_000,
}

function liveAt(version: number, limits = [{ id: "day", amount: "100", window: "day" as const }]) {
  return {
    budget: {
      key: "customer:acme",
      unit: "money:USD",
      version,
      limits: limits.map((limit) => ({ ...limit, enforce: "soft" as const })),
      holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
      onUnavailable: "deny",
      closesAt: null,
      closed: false,
      balance: { remaining: null, held: "0", limits: [], asOf: 1_796_083_200_000 },
      operations: {
        upsert: version,
        authorize: 0,
        settle: 0,
        release: 0,
        charge: 0,
        record: 0,
        lease: 0,
        report: 0,
      },
    },
    history: [],
    expiringNext: { rows: [], examined: 0, next: null },
    listed: "0",
    closedRecently: [],
  } satisfies InspectBudgetResponse
}

type Answer = Result<InspectBudgetResponse, FetchError | UnPriceBudgetError>

function harness(answer: Answer, catalogRow: BudgetCatalogRow | null = row) {
  const calls = {
    inspected: [] as InspectBudgetRequest[],
    recorded: [] as BudgetCatalogFacts[],
    forgotten: [] as string[],
  }
  let stored = catalogRow
  const budgetCatalog = {
    async get(_projectId: string, where: { id: string } | { key: string }) {
      const matches = stored && ("id" in where ? stored.id === where.id : stored.key === where.key)
      return Ok(matches ? stored : null)
    },
    async record(_projectId: string, facts: BudgetCatalogFacts) {
      calls.recorded.push(facts)
      stored = { ...(stored ?? { ...row, id: "bgt_new" }), ...facts }
    },
    async forget(_projectId: string, key: string) {
      calls.forgotten.push(key)
    },
  } as unknown as BudgetCatalogService
  const budgetOperator: BudgetOperatorGateway = {
    async inspect(input) {
      calls.inspected.push(input)
      return answer
    },
    release: () => Promise.reject(new Error("inspect never releases")),
  }
  const logger = { error: () => {} } as unknown as Logger
  return { calls, deps: { services: { budgetCatalog, budgetOperator }, logger } }
}

const notFound = Err(new UnPriceBudgetError({ code: "BUDGET_NOT_FOUND" }))

describe("inspectBudget", () => {
  it("inspects the row's key and records the live facts when the version drifted", async () => {
    const { calls, deps } = harness(Ok(liveAt(3)))

    const result = await inspectBudget(deps, {
      projectId: "proj_1",
      id: "bgt_1",
      query: { probe: "2" },
    })

    expect(calls.inspected).toEqual([{ projectId: "proj_1", key: "customer:acme", probe: "2" }])
    const facts = {
      key: "customer:acme",
      unit: "money:USD",
      version: 3,
      cap: "soft",
      limits: [{ id: "day", window: "day", enforce: "soft", amount: "100" }],
      closesAt: null,
    }
    expect(calls.recorded).toEqual([facts])
    expect(result.val?.catalog).toEqual({ ...row, ...facts, status: "open" })
    expect(result.val?.budget.version).toBe(3)
  })

  it("writes nothing when the catalog already has the live version", async () => {
    const { calls, deps } = harness(Ok(liveAt(2)))

    const result = await inspectBudget(deps, { projectId: "proj_1", id: "bgt_1", query: {} })

    expect([calls.recorded, calls.forgotten]).toEqual([[], []])
    expect(result.val?.catalog).toEqual(row)
  })

  it("forgets the row and answers not found when the object has no budget", async () => {
    const { calls, deps } = harness(notFound)

    const result = await inspectBudget(deps, { projectId: "proj_1", id: "bgt_1", query: {} })

    expect(calls.forgotten).toEqual(["customer:acme"])
    expect(result.err).toBeInstanceOf(UnPriceBudgetError)
  })

  it("keeps the row when the inspect fails in transit", async () => {
    const { calls, deps } = harness(Err(new FetchError({ message: "timeout", retry: true })))

    const result = await inspectBudget(deps, { projectId: "proj_1", id: "bgt_1", query: {} })

    expect(calls.forgotten).toEqual([])
    expect(result.err).toBeInstanceOf(FetchError)
  })

  it("answers not found for an id the catalog does not have, without asking the object", async () => {
    const { calls, deps } = harness(Ok(liveAt(2)))

    const result = await inspectBudget(deps, { projectId: "proj_1", id: "bgt_gone", query: {} })

    expect(calls.inspected).toEqual([])
    expect(result.err).toBeInstanceOf(UnPriceBudgetError)
  })
})

describe("openBudgetByKey", () => {
  it("registers a budget the catalog missed and returns its id", async () => {
    const { calls, deps } = harness(Ok(liveAt(5)), null)

    const result = await openBudgetByKey(deps, { projectId: "proj_1", key: "customer:acme" })

    expect(calls.inspected).toEqual([{ projectId: "proj_1", key: "customer:acme" }])
    expect(calls.recorded.map((facts) => facts.version)).toEqual([5])
    expect(result.val).toEqual({ id: "bgt_new" })
  })

  it("answers not found and forgets any stale row when the object has no budget", async () => {
    const { calls, deps } = harness(notFound)

    const result = await openBudgetByKey(deps, { projectId: "proj_1", key: "customer:acme" })

    expect([calls.recorded, calls.forgotten]).toEqual([[], ["customer:acme"]])
    expect(result.err).toBeInstanceOf(UnPriceBudgetError)
  })
})
