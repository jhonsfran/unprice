import { type BudgetCatalogFacts, listBudgetsInputSchema } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../test-fixtures/database"
import { seedTestDb } from "../test-fixtures/seed-db"
import { BudgetCatalogService } from "./service"

const db = createTestDatabaseConnection()
const projectId = "proj_test"
const day = 24 * 60 * 60 * 1000

const catalog = new BudgetCatalogService({
  db,
  logger: { error: vi.fn() } as unknown as Logger,
})

function facts(overrides: Partial<BudgetCatalogFacts> = {}): BudgetCatalogFacts {
  return {
    key: "customer:acme",
    unit: "money:USD",
    version: 1,
    cap: "hard",
    limits: [{ id: "daily", window: "day", enforce: "hard", amount: "100" }],
    closesAt: null,
    ...overrides,
  }
}

const query = (input: Record<string, unknown> = {}) =>
  listBudgetsInputSchema.parse({
    page: 1,
    page_size: 10,
    search: null,
    from: null,
    to: null,
    ...input,
  })

async function list(input: Record<string, unknown> = {}) {
  const result = await catalog.list(projectId, query(input))
  if (result.err) throw result.err
  return result.val
}

const keys = async (input: Record<string, unknown> = {}) =>
  (await list(input)).rows.map((row) => row.key).sort()

describe("BudgetCatalogService", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures: ["base-project.sql"] })
  })

  describe("record", () => {
    it("keeps one row per key and applies only newer versions", async () => {
      await catalog.record(projectId, facts())
      const [created] = (await list()).rows

      await catalog.record(projectId, facts({ version: 3, cap: "soft", limits: [] }))
      await catalog.record(projectId, facts({ version: 2, unit: "money:EUR" }))
      await catalog.record(projectId, facts({ version: 3, cap: "none" }))

      const { rows } = await list()
      expect(
        rows.map(({ id, version, unit, cap, limits }) => ({ id, version, unit, cap, limits }))
      ).toEqual([{ id: created?.id, version: 3, unit: "money:USD", cap: "soft", limits: [] }])
      expect(created?.id).toMatch(/^bgt_/)
    })

    it("admits a re-created budget once the old one closed past retention", async () => {
      const closedLongAgo = Date.now() - 31 * day
      await catalog.record(projectId, facts({ version: 4, closesAt: closedLongAgo }))
      await catalog.record(projectId, facts({ version: 1, cap: "none", limits: [] }))

      const { rows } = await list()
      expect(rows.map(({ version, cap, status }) => ({ version, cap, status }))).toEqual([
        { version: 1, cap: "none", status: "open" },
      ])
    })

    it("does not re-create over a budget closed within retention", async () => {
      const closedRecently = Date.now() - day
      await catalog.record(projectId, facts({ version: 4, closesAt: closedRecently }))
      await catalog.record(projectId, facts({ version: 1 }))

      const { rows } = await list()
      expect(rows.map(({ version, closesAt, status }) => ({ version, closesAt, status }))).toEqual([
        { version: 4, closesAt: closedRecently, status: "closed" },
      ])
    })
  })

  describe("list", () => {
    beforeEach(async () => {
      const now = Date.now()
      await catalog.record(projectId, facts({ key: "customer:acme" }))
      await catalog.record(projectId, facts({ key: "customer:a_me", cap: "soft" }))
      await catalog.record(projectId, facts({ key: "customer%x", unit: "credits:gpu" }))
      await catalog.record(projectId, facts({ key: "run:r_42", closesAt: now + day }))
      await catalog.record(projectId, facts({ key: "run:r_41", closesAt: now - day }))
      await catalog.record(projectId, facts({ key: "run:r_1", closesAt: now - 31 * day }))
    })

    it("hides budgets closed past retention", async () => {
      expect(await keys()).toEqual([
        "customer%x",
        "customer:a_me",
        "customer:acme",
        "run:r_41",
        "run:r_42",
      ])
    })

    it("matches the search as a literal key prefix", async () => {
      expect(await keys({ search: "customer:a_" })).toEqual(["customer:a_me"])
      expect(await keys({ search: "customer%" })).toEqual(["customer%x"])
      expect(await keys({ search: "acme" })).toEqual([])
    })

    it("filters by status, unit, and cap", async () => {
      expect(await keys({ filters: { status: ["closing"] } })).toEqual(["run:r_42"])
      expect(await keys({ filters: { status: ["closed", "closing"] } })).toEqual([
        "run:r_41",
        "run:r_42",
      ])
      expect(await keys({ filters: { unit: ["credits:gpu"] } })).toEqual(["customer%x"])
      expect(await keys({ filters: { cap: ["soft"], status: ["open"] } })).toEqual([
        "customer:a_me",
      ])
    })

    it("pages the most recently changed first", async () => {
      const first = await list({ page_size: 2 })
      const third = await list({ page: 3, page_size: 2 })

      expect({
        pageCount: first.pageCount,
        first: first.rows.map((row) => row.key),
        third: third.rows.map((row) => row.key),
      }).toEqual({ pageCount: 3, first: ["run:r_41", "run:r_42"], third: ["customer:acme"] })
    })
  })
})
