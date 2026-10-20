import type { Logger } from "@unprice/logs"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../test-fixtures/database"
import { seedTestDb } from "../test-fixtures/seed-db"
import { type BudgetAuditRequest, BudgetAuditService } from "./service"

const db = createTestDatabaseConnection()
const projectId = "proj_test"
const HELD_AT = 1_796_083_140_000

const audit = new BudgetAuditService({
  db,
  logger: { error: vi.fn() } as unknown as Logger,
})

const releaseOf = (subject: string, overrides: Partial<BudgetAuditRequest> = {}) => ({
  budgetId: "bgt_1",
  action: "release_hold" as const,
  subject,
  subjectCreatedAt: HELD_AT,
  actorUserId: "usr_1",
  reason: "worker crashed before the call",
  ...overrides,
})

async function value<T>(result: Promise<{ val?: T; err?: Error }>): Promise<T> {
  const { val, err } = await result
  if (err) throw err
  return val as T
}

const summary = (row: { subject: string; status: string; actorUserId: string }) =>
  `${row.subject} ${row.status} ${row.actorUserId}`

describe("BudgetAuditService", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures: ["base-project.sql"] })
  })

  it("reuses the row of the same action on the same subject and resolves it once", async () => {
    const first = await value(audit.request(projectId, releaseOf("h_7")))
    const retry = await value(audit.request(projectId, releaseOf("h_7", { actorUserId: "usr_2" })))
    const applied = await value(
      audit.resolve(projectId, first.id, { status: "applied", released: "5" })
    )
    const late = await value(
      audit.resolve(projectId, first.id, { status: "rejected", rejectionCode: "HOLD_CLOSED" })
    )
    const again = await value(audit.request(projectId, releaseOf("h_7")))

    expect(first.id).toMatch(/^bga_/)
    expect([retry.id, retry.status, retry.actorUserId]).toEqual([first.id, "requested", "usr_1"])
    expect(applied).toMatchObject({ id: first.id, status: "applied", released: "5" })
    expect(late).toEqual(applied)
    expect(again).toEqual(applied)
    expect(await value(audit.list(projectId, "bgt_1", 20))).toEqual([applied])
  })

  it("keeps a row per creation time of the same hold id, and one row per id and time", async () => {
    const recreatedAt = HELD_AT + 7 * 86_400_000
    const closed = await value(audit.request(projectId, releaseOf("h_1")))
    await value(audit.resolve(projectId, closed.id, { status: "applied", released: "2" }))
    const reborn = await value(
      audit.request(projectId, releaseOf("h_1", { subjectCreatedAt: recreatedAt }))
    )
    const retry = await value(
      audit.request(projectId, releaseOf("h_1", { subjectCreatedAt: recreatedAt }))
    )

    const listed = await value(audit.list(projectId, "bgt_1", 20))

    expect([reborn.id === closed.id, retry.id === reborn.id]).toEqual([false, true])
    expect(
      listed
        .sort((a, b) => a.subjectCreatedAt - b.subjectCreatedAt)
        .map((row) => [row.subject, row.subjectCreatedAt, row.status])
    ).toEqual([
      ["h_1", HELD_AT, "applied"],
      ["h_1", recreatedAt, "requested"],
    ])
  })

  it("lists one budget's actions newest first, up to the limit", async () => {
    for (const subject of ["h_1", "h_2", "h_3"]) {
      await value(audit.request(projectId, releaseOf(subject)))
    }
    await value(audit.request(projectId, releaseOf("h_9", { budgetId: "bgt_other" })))
    const rejected = await value(audit.request(projectId, releaseOf("h_4")))
    await value(
      audit.resolve(projectId, rejected.id, { status: "rejected", rejectionCode: "HOLD_RETIRED" })
    )

    const listed = await value(audit.list(projectId, "bgt_1", 3))

    expect(listed.map(summary)).toEqual([
      "h_4 rejected usr_1",
      "h_3 requested usr_1",
      "h_2 requested usr_1",
    ])
    expect(listed[0]).toMatchObject({ rejectionCode: "HOLD_RETIRED" })
  })
})
