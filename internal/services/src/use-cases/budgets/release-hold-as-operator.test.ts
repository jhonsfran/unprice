import type {
  BudgetAuditRow,
  BudgetCatalogRow,
  ReleaseBudgetResponse,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import { describe, expect, it } from "vitest"
import type { BudgetAuditOutcome, BudgetAuditRequest, BudgetAuditService } from "../../budget-audit"
import type { BudgetCatalogService } from "../../budget-catalog"
import { UnPriceBudgetError } from "../../budgets"
import type { BudgetOperatorGateway } from "./operator-gateway"
import { releaseHoldAsOperator } from "./release-hold-as-operator"

const AT = 1_796_083_200_000
const HELD_AT = AT - 60_000

const catalogRow: BudgetCatalogRow = {
  id: "bgt_1",
  key: "customer:acme",
  unit: "money:USD",
  version: 2,
  cap: "hard",
  limits: [{ id: "day", window: "day", enforce: "hard", amount: "100" }],
  closesAt: null,
  status: "open",
  createdAt: AT,
  updatedAt: AT,
}

const releasedFive: ReleaseBudgetResponse = {
  holdId: "h_7",
  released: "5",
  replayed: false,
  balance: { remaining: "100", held: "0", limits: [], asOf: AT },
}

type Answer = Result<ReleaseBudgetResponse, FetchError | UnPriceBudgetError>

/**
 * The audit table's contract in memory: one row per (budget, action, subject, subject's creation
 * time), resolved once.
 */
function harness(...answers: Answer[]) {
  const rows = new Map<string, BudgetAuditRow>()
  const released: { projectId: string; key: string; holdId: string }[] = []
  let nextId = 1

  const budgetAudit = {
    async request(_projectId: string, request: BudgetAuditRequest) {
      const subject = `${request.budgetId}:${request.action}:${request.subject}:${request.subjectCreatedAt}`
      const row = rows.get(subject) ?? {
        id: `bga_${nextId++}`,
        ...request,
        status: "requested" as const,
        createdAt: AT,
        updatedAt: AT,
      }
      rows.set(subject, row)
      return Ok(row)
    },
    async resolve(_projectId: string, id: string, outcome: BudgetAuditOutcome) {
      const [subject, row] = [...rows].find(([, candidate]) => candidate.id === id) ?? []
      if (!subject || !row) throw new Error(`no row ${id}`)
      const resolved: BudgetAuditRow = row.status === "requested" ? { ...row, ...outcome } : row
      rows.set(subject, resolved)
      return Ok(resolved)
    },
  } as unknown as BudgetAuditService

  const budgetCatalog = {
    async get(_projectId: string, where: { id: string }) {
      return Ok(where.id === catalogRow.id ? catalogRow : null)
    },
  } as unknown as BudgetCatalogService

  const budgetOperator: BudgetOperatorGateway = {
    inspect: () => Promise.reject(new Error("release never inspects")),
    async release(input) {
      released.push(input)
      const answer = answers.shift()
      if (!answer) throw new Error("no answer left")
      return answer
    },
  }

  const release = (
    overrides: {
      budgetId?: string
      holdId?: string
      holdCreatedAt?: number
      actorUserId?: string
    } = {}
  ) =>
    releaseHoldAsOperator(
      { services: { budgetCatalog, budgetAudit, budgetOperator } },
      {
        projectId: "proj_1",
        budgetId: "bgt_1",
        holdId: "h_7",
        holdCreatedAt: HELD_AT,
        actorUserId: "usr_1",
        reason: "worker crashed before the call",
        ...overrides,
      }
    )

  return { release, rows: () => [...rows.values()], released }
}

const audit = (overrides: Partial<BudgetAuditRow>): BudgetAuditRow =>
  ({
    id: "bga_1",
    budgetId: "bgt_1",
    action: "release_hold",
    subject: "h_7",
    subjectCreatedAt: HELD_AT,
    actorUserId: "usr_1",
    reason: "worker crashed before the call",
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  }) as BudgetAuditRow

describe("releaseHoldAsOperator", () => {
  it("requests the row, releases the hold at the row's key, and applies the released amount", async () => {
    const { release, rows, released } = harness(Ok(releasedFive))

    const result = await release()

    expect(result.val).toEqual(audit({ status: "applied", released: "5" }))
    expect(rows()).toEqual([audit({ status: "applied", released: "5" })])
    expect(released).toEqual([
      { projectId: "proj_1", key: "customer:acme", holdId: "h_7", holdCreatedAt: HELD_AT },
    ])
  })

  it("leaves the row requested on a transport failure and reuses it on the retry", async () => {
    const down = new FetchError({ message: "network down", retry: true })
    const { release, rows, released } = harness(Err(down), Ok({ ...releasedFive, replayed: true }))

    const failed = await release()
    const afterFailure = rows()
    const retried = await release({ actorUserId: "usr_2" })

    expect(failed.err).toBe(down)
    expect(afterFailure).toEqual([audit({ status: "requested" })])
    expect(retried.val).toEqual(audit({ status: "applied", released: "5" }))
    expect([rows().length, released.length]).toEqual([1, 2])
  })

  it("stores HOLD_CLOSED as a rejected row with that code", async () => {
    const closed = new UnPriceBudgetError({ code: "HOLD_CLOSED", holdId: "h_7", status: "expired" })
    const { release, rows } = harness(Err(closed))

    const result = await release()

    expect(result.val).toEqual(audit({ status: "rejected", rejectionCode: "HOLD_CLOSED" }))
    expect(rows()).toEqual([audit({ status: "rejected", rejectionCode: "HOLD_CLOSED" })])
  })

  it("returns an applied row again without calling the budget a second time", async () => {
    const { release, released } = harness(Ok(releasedFive))

    await release()
    const again = await release()

    expect(again.val).toEqual(audit({ status: "applied", released: "5" }))
    expect(released).toHaveLength(1)
  })

  it("releases a recreated budget's h_1 under a new row, though the closed budget's h_1 was applied", async () => {
    const earlier = HELD_AT - 7 * 86_400_000
    const { release, rows, released } = harness(
      Ok({ ...releasedFive, holdId: "h_1", released: "2" }),
      Ok({ ...releasedFive, holdId: "h_1", released: "3" })
    )

    await release({ holdId: "h_1", holdCreatedAt: earlier })
    const reborn = await release({ holdId: "h_1", holdCreatedAt: HELD_AT })

    expect(reborn.val).toEqual(
      audit({ id: "bga_2", subject: "h_1", status: "applied", released: "3" })
    )
    expect(rows().map((row) => [row.id, row.subjectCreatedAt, row.status])).toEqual([
      ["bga_1", earlier, "applied"],
      ["bga_2", HELD_AT, "applied"],
    ])
    expect(released).toEqual([
      { projectId: "proj_1", key: "customer:acme", holdId: "h_1", holdCreatedAt: earlier },
      { projectId: "proj_1", key: "customer:acme", holdId: "h_1", holdCreatedAt: HELD_AT },
    ])
  })

  it("answers BUDGET_NOT_FOUND for an id the catalog does not have, writing nothing", async () => {
    const { release, rows, released } = harness()

    const result = await release({ budgetId: "bgt_gone" })

    expect(result.err instanceof UnPriceBudgetError && result.err.code).toBe("BUDGET_NOT_FOUND")
    expect([rows(), released]).toEqual([[], []])
  })
})
