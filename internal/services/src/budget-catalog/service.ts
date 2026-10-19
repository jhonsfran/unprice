import {
  type Database,
  type SQL,
  and,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  like,
  lte,
  or,
  sql,
} from "@unprice/db"
import { budgets } from "@unprice/db/schema"
import { newId, withPagination } from "@unprice/db/utils"
import {
  type BudgetCatalogFacts,
  type BudgetCatalogRow,
  type BudgetCatalogStatus,
  CLOSED_BUDGET_RETENTION_MS,
  type ListBudgetsInput,
} from "@unprice/db/validators"
import { BaseError, Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { catalogStatusOf } from "../budgets/catalog"

export class BudgetCatalogServiceError extends BaseError {
  public readonly retry = false
  public readonly name = "BudgetCatalogServiceError"
}

type BudgetCatalogServiceDeps = {
  db: Database
  logger: Logger
}

/** The dashboard's list of budgets. The budget's Durable Object stays the source of truth. */
export class BudgetCatalogService {
  constructor(private readonly deps: BudgetCatalogServiceDeps) {}

  /**
   * Writes the facts of a committed upsert. Only a newer version replaces a row, so retries and
   * late copies are no-ops; a row closed past retention is replaced by any version, because its
   * object deleted itself and an upsert creates it anew at version 1.
   */
  async record(projectId: string, facts: BudgetCatalogFacts): Promise<void> {
    const closesAt = facts.closesAt === null ? null : new Date(facts.closesAt)
    await this.deps.db
      .insert(budgets)
      .values({
        id: newId("budget"),
        projectId,
        key: facts.key,
        unit: facts.unit,
        version: facts.version,
        cap: facts.cap,
        limits: facts.limits,
        closesAt,
      })
      .onConflictDoUpdate({
        target: [budgets.projectId, budgets.key],
        set: {
          unit: sql`excluded.unit`,
          version: sql`excluded.version`,
          cap: sql`excluded.cap`,
          limits: sql`excluded.limits`,
          closesAt: sql`excluded.closes_at`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${budgets.version} < excluded.version OR ${budgets.closesAt} < now() - ${CLOSED_BUDGET_RETENTION_MS} * interval '1 millisecond'`,
      })
  }

  /** A page of the project's budgets, most recently changed first, without long-closed ones. */
  async list(
    projectId: string,
    input: ListBudgetsInput,
    now = Date.now()
  ): Promise<Result<{ rows: BudgetCatalogRow[]; pageCount: number }, BudgetCatalogServiceError>> {
    const at = new Date(now)
    const statusOf: Record<BudgetCatalogStatus, SQL | undefined> = {
      open: isNull(budgets.closesAt),
      closing: gt(budgets.closesAt, at),
      closed: lte(budgets.closesAt, at),
    }
    const { status, unit, cap } = input.filters
    const where = and(
      eq(budgets.projectId, projectId),
      or(
        isNull(budgets.closesAt),
        gte(budgets.closesAt, new Date(now - CLOSED_BUDGET_RETENTION_MS))
      ),
      input.search ? like(budgets.key, `${escapeLike(input.search)}%`) : undefined,
      status?.length ? or(...status.map((value) => statusOf[value])) : undefined,
      unit?.length ? inArray(budgets.unit, unit) : undefined,
      cap?.length ? inArray(budgets.cap, cap) : undefined
    ) as SQL

    try {
      const [data, total] = await Promise.all([
        withPagination(
          this.deps.db.select().from(budgets).$dynamic(),
          where,
          [
            { column: budgets.updatedAt, order: "desc" },
            { column: budgets.id, order: "desc" },
          ],
          input.page,
          input.page_size
        ),
        this.deps.db
          .select({ count: count() })
          .from(budgets)
          .where(where)
          .then((rows) => rows[0]?.count ?? 0),
      ])

      return Ok({
        rows: data.map((row) => {
          const closesAt = row.closesAt?.getTime() ?? null
          return {
            id: row.id,
            key: row.key,
            unit: row.unit,
            version: row.version,
            cap: row.cap,
            limits: row.limits,
            closesAt,
            status: catalogStatusOf(closesAt, now),
            createdAt: row.createdAt.getTime(),
            updatedAt: row.updatedAt.getTime(),
          }
        }),
        pageCount: Math.ceil(total / input.page_size),
      })
    } catch (error) {
      this.deps.logger.error(error instanceof Error ? error : new Error(String(error)), {
        context: "error listing budgets",
        projectId,
      })
      return Err(new BudgetCatalogServiceError({ message: "Failed to list budgets" }))
    }
  }
}

/** LIKE treats `%`, `_`, and its escape `\` as syntax; a key prefix must match them literally. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`)
}
