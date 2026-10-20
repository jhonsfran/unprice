import { type Database, and, desc, eq, sql } from "@unprice/db"
import { budgetAudit } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type {
  BudgetAuditAction,
  BudgetAuditRow,
  BudgetReleaseRejectionCode,
} from "@unprice/db/validators"
import { BaseError, Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"

export class BudgetAuditServiceError extends BaseError {
  public readonly retry = false
  public readonly name = "BudgetAuditServiceError"
}

type BudgetAuditServiceDeps = {
  db: Database
  logger: Logger
}

export type BudgetAuditRequest = {
  budgetId: string
  action: BudgetAuditAction
  subject: string
  actorUserId: string
  reason: string
}

/** How the budget answered a requested action. */
export type BudgetAuditOutcome =
  | { status: "applied"; released: string }
  | { status: "rejected"; rejectionCode: BudgetReleaseRejectionCode }

/** Operator actions on budgets: one row per action and subject, requested, then resolved once. */
export class BudgetAuditService {
  constructor(private readonly deps: BudgetAuditServiceDeps) {}

  /**
   * A new `requested` row, or the row an earlier attempt at the same action on the same subject
   * left behind, whatever its status. The earlier row keeps its actor and reason.
   */
  async request(
    projectId: string,
    request: BudgetAuditRequest
  ): Promise<Result<BudgetAuditRow, BudgetAuditServiceError>> {
    return this.run(projectId, "error requesting a budget action", async () => {
      const [row] = await this.deps.db
        .insert(budgetAudit)
        .values({ id: newId("budget_audit"), projectId, status: "requested", ...request })
        .onConflictDoUpdate({
          target: [
            budgetAudit.projectId,
            budgetAudit.budgetId,
            budgetAudit.action,
            budgetAudit.subject,
          ],
          // a no-op update, so RETURNING yields the existing row
          set: { updatedAt: sql`${budgetAudit.updatedAt}` },
        })
        .returning()
      if (!row) throw new Error("the audit insert returned no row")
      return toRow(row)
    })
  }

  /** Moves a `requested` row to its outcome. A row already resolved keeps its first outcome. */
  async resolve(
    projectId: string,
    id: string,
    outcome: BudgetAuditOutcome
  ): Promise<Result<BudgetAuditRow, BudgetAuditServiceError>> {
    return this.run(projectId, "error resolving a budget action", async () => {
      const where = and(eq(budgetAudit.projectId, projectId), eq(budgetAudit.id, id))
      const [updated] = await this.deps.db
        .update(budgetAudit)
        .set({
          status: outcome.status,
          released: outcome.status === "applied" ? outcome.released : null,
          rejectionCode: outcome.status === "rejected" ? outcome.rejectionCode : null,
          updatedAt: sql`now()`,
        })
        .where(and(where, eq(budgetAudit.status, "requested")))
        .returning()
      const [row] = updated
        ? [updated]
        : await this.deps.db.select().from(budgetAudit).where(where).limit(1)
      if (!row) throw new Error(`no audit row ${id}`)
      return toRow(row)
    })
  }

  /** The budget's latest actions, newest first. */
  async list(
    projectId: string,
    budgetId: string,
    limit: number
  ): Promise<Result<BudgetAuditRow[], BudgetAuditServiceError>> {
    return this.run(projectId, "error listing budget actions", async () => {
      const rows = await this.deps.db
        .select()
        .from(budgetAudit)
        .where(and(eq(budgetAudit.projectId, projectId), eq(budgetAudit.budgetId, budgetId)))
        .orderBy(desc(budgetAudit.createdAt), desc(budgetAudit.id))
        .limit(limit)
      return rows.map(toRow)
    })
  }

  private async run<T>(
    projectId: string,
    context: string,
    query: () => Promise<T>
  ): Promise<Result<T, BudgetAuditServiceError>> {
    try {
      return Ok(await query())
    } catch (error) {
      this.deps.logger.error(error instanceof Error ? error : new Error(String(error)), {
        context,
        projectId,
      })
      return Err(new BudgetAuditServiceError({ message: "Failed to write the budget audit" }))
    }
  }
}

function toRow(row: typeof budgetAudit.$inferSelect): BudgetAuditRow {
  const base = {
    id: row.id,
    budgetId: row.budgetId,
    action: row.action,
    subject: row.subject,
    actorUserId: row.actorUserId,
    reason: row.reason,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  }
  if (row.status === "applied" && row.released !== null) {
    return { ...base, status: "applied", released: row.released }
  }
  if (row.status === "rejected" && row.rejectionCode !== null) {
    return { ...base, status: "rejected", rejectionCode: row.rejectionCode }
  }
  if (row.status === "requested") return { ...base, status: "requested" }
  throw new Error(`audit row ${row.id} is ${row.status} without its outcome`)
}
