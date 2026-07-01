import {
  type Database,
  type SQL,
  and,
  between,
  count,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  lte,
  or,
} from "@unprice/db"
import { type BudgetRunStatus, budgetRuns, customers } from "@unprice/db/schema"
import { newId, withPagination } from "@unprice/db/utils"
import type { BudgetRun, Customer, SearchParamsDataTable } from "@unprice/db/validators"
import { BaseError, Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { Cache } from "../cache"
import { cachedQuery } from "../utils/cached-query"

type BudgetRunWorkloadType = "agent" | "workflow" | "job" | "tool" | "custom"

export class BudgetRunServiceError extends BaseError {
  public readonly retry = false
  public readonly name = "BudgetRunServiceError"
}

type BudgetRunServiceDeps = {
  db: Database
  logger: Logger
  cache: Cache
  waitUntil: (promise: Promise<unknown>) => void
}

type BudgetRunRow = typeof budgetRuns.$inferSelect
export type BudgetRunWithCustomer = BudgetRun & { customer: Customer }

export class BudgetRunService {
  constructor(private readonly deps: BudgetRunServiceDeps) {}

  async createRun(input: {
    projectId: string
    customerId: string
    budgetAmount: number
    remainingAmount: number
    currency: string
    idempotencyKey: string
    workloadType?: BudgetRunWorkloadType | null
    workloadId?: string | null
    traceId?: string | null
    parentRunId?: string | null
    metadata?: Record<string, unknown>
    expiresAt?: Date | null
  }): Promise<Result<BudgetRunRow, BudgetRunServiceError>> {
    try {
      const id = newId("budget_run")
      const [row] = await this.deps.db
        .insert(budgetRuns)
        .values({
          id,
          projectId: input.projectId,
          customerId: input.customerId,
          status: "running",
          budgetAmount: input.budgetAmount,
          consumedAmount: 0,
          remainingAmount: input.remainingAmount,
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
          workloadType: input.workloadType ?? null,
          workloadId: input.workloadId ?? null,
          traceId: input.traceId ?? null,
          parentRunId: input.parentRunId ?? null,
          metadata: input.metadata ?? {},
          expiresAt: input.expiresAt ?? null,
        })
        .onConflictDoNothing({
          target: [budgetRuns.projectId, budgetRuns.customerId, budgetRuns.idempotencyKey],
        })
        .returning()

      // If conflict, fetch existing row
      if (!row) {
        return this.getRunByIdempotencyKey({
          projectId: input.projectId,
          customerId: input.customerId,
          idempotencyKey: input.idempotencyKey,
        })
      }

      return Ok(row)
    } catch (_error) {
      return Err(
        new BudgetRunServiceError({
          message: "Failed to create budget run",
        })
      )
    }
  }

  async getRun(input: {
    projectId: string
    runId: string
  }): Promise<Result<BudgetRunRow, BudgetRunServiceError>> {
    const cacheKey = `${input.projectId}:${input.runId}`

    const { val, err } = await cachedQuery({
      cache: this.deps.cache.budgetRun,
      cacheKey,
      load: async () => {
        const row = await this.deps.db.query.budgetRuns.findFirst({
          where: and(eq(budgetRuns.id, input.runId), eq(budgetRuns.projectId, input.projectId)),
        })
        return row ?? null
      },
      wrapLoadError: (error) =>
        new FetchError({
          message: error.message ?? "Failed to get budget run",
          retry: false,
        }),
    })

    if (err) {
      return Err(
        new BudgetRunServiceError({
          message: "Failed to get budget run",
        })
      )
    }

    if (!val) {
      return Err(
        new BudgetRunServiceError({
          message: "RUN_NOT_FOUND",
        })
      )
    }

    return Ok(val)
  }

  async listRunsByProject(input: {
    projectId: string
    query: SearchParamsDataTable
  }): Promise<
    Result<{ runs: BudgetRunWithCustomer[]; pageCount: number }, BudgetRunServiceError>
  > {
    const runColumns = getTableColumns(budgetRuns)
    const customerColumns = getTableColumns(customers)
    const runStatusValues = new Set<BudgetRunStatus>([
      "running",
      "completed",
      "expired",
      "canceled",
      "budget_exceeded",
      "failed",
    ])
    const filter = `%${input.query.search ?? ""}%`
    const statusFilters =
      input.query.filters.status?.filter(
        (value): value is BudgetRunStatus =>
          typeof value === "string" && runStatusValues.has(value as BudgetRunStatus)
      ) ?? []

    try {
      const { data, total } = await this.deps.db.transaction(async (tx) => {
        const expressions = [
          eq(runColumns.projectId, input.projectId),
          input.query.search
            ? or(
                ilike(runColumns.id, filter),
                ilike(runColumns.customerId, filter),
                ilike(runColumns.traceId, filter),
                ilike(runColumns.workloadId, filter),
                ilike(customerColumns.email, filter),
                ilike(customerColumns.name, filter)
              )
            : undefined,
          statusFilters.length > 0 ? inArray(runColumns.status, statusFilters) : undefined,
        ]
        const startedFrom = input.query.from !== null ? new Date(input.query.from) : null
        const startedTo = input.query.to !== null ? new Date(input.query.to) : null
        const whereQuery = and(
          and(...expressions),
          startedFrom && startedTo
            ? between(runColumns.startedAt, startedFrom, startedTo)
            : undefined,
          startedFrom ? gte(runColumns.startedAt, startedFrom) : undefined,
          startedTo ? lte(runColumns.startedAt, startedTo) : undefined
        ) as SQL<BudgetRun>
        const joinCustomers = and(
          eq(budgetRuns.customerId, customers.id),
          eq(customers.projectId, budgetRuns.projectId)
        )
        const query = tx
          .select({
            run: budgetRuns,
            customer: customerColumns,
          })
          .from(budgetRuns)
          .innerJoin(customers, joinCustomers)
          .$dynamic()

        const data = await withPagination(
          query,
          whereQuery,
          [
            {
              column: runColumns.startedAt,
              order: "desc",
            },
            {
              column: runColumns.id,
              order: "desc",
            },
          ],
          input.query.page,
          input.query.page_size
        )

        const total = await tx
          .select({
            count: count(),
          })
          .from(budgetRuns)
          .innerJoin(customers, joinCustomers)
          .where(whereQuery)
          .execute()
          .then((res) => res[0]?.count ?? 0)

        return { data, total }
      })

      return Ok({
        runs: data.map((row) => ({
          ...row.run,
          customer: row.customer,
        })) as unknown as BudgetRunWithCustomer[],
        pageCount: Math.ceil(total / input.query.page_size),
      })
    } catch (error) {
      this.deps.logger.error(error instanceof Error ? error : new Error(String(error)), {
        context: "error listing budget runs by project",
        projectId: input.projectId,
      })

      return Err(
        new BudgetRunServiceError({
          message: "Failed to list budget runs",
        })
      )
    }
  }

  async updateRunReservation(input: {
    projectId: string
    runId: string
    walletReservationId: string
  }): Promise<Result<BudgetRunRow, BudgetRunServiceError>> {
    try {
      const [row] = await this.deps.db
        .update(budgetRuns)
        .set({
          walletReservationId: input.walletReservationId,
          updatedAt: new Date(),
        })
        .where(and(eq(budgetRuns.id, input.runId), eq(budgetRuns.projectId, input.projectId)))
        .returning()

      if (!row) {
        return Err(new BudgetRunServiceError({ message: "RUN_NOT_FOUND" }))
      }

      // Invalidate cache after mutation
      const cacheKey = `${input.projectId}:${input.runId}`
      this.deps.waitUntil(this.deps.cache.budgetRun.remove(cacheKey))

      return Ok(row)
    } catch (_error) {
      return Err(
        new BudgetRunServiceError({
          message: "Failed to update run reservation",
        })
      )
    }
  }

  async updateRunSummary(input: {
    projectId: string
    runId: string
    status: BudgetRunStatus
    statusReason?: string | null
    consumedAmount: number
    remainingAmount: number
    endedAt?: Date | null
  }): Promise<Result<BudgetRunRow, BudgetRunServiceError>> {
    try {
      const [row] = await this.deps.db
        .update(budgetRuns)
        .set({
          status: input.status,
          statusReason: input.statusReason ?? null,
          consumedAmount: input.consumedAmount,
          remainingAmount: input.remainingAmount,
          endedAt: input.endedAt ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(budgetRuns.id, input.runId), eq(budgetRuns.projectId, input.projectId)))
        .returning()

      if (!row) {
        return Err(new BudgetRunServiceError({ message: "RUN_NOT_FOUND" }))
      }

      // Invalidate cache after mutation
      const cacheKey = `${input.projectId}:${input.runId}`
      this.deps.waitUntil(this.deps.cache.budgetRun.remove(cacheKey))

      return Ok(row)
    } catch (_error) {
      return Err(
        new BudgetRunServiceError({
          message: "Failed to update run summary",
        })
      )
    }
  }

  private async getRunByIdempotencyKey(input: {
    projectId: string
    customerId: string
    idempotencyKey: string
  }): Promise<Result<BudgetRunRow, BudgetRunServiceError>> {
    try {
      const row = await this.deps.db.query.budgetRuns.findFirst({
        where: and(
          eq(budgetRuns.projectId, input.projectId),
          eq(budgetRuns.customerId, input.customerId),
          eq(budgetRuns.idempotencyKey, input.idempotencyKey)
        ),
      })

      if (!row) {
        return Err(new BudgetRunServiceError({ message: "RUN_NOT_FOUND" }))
      }

      return Ok(row)
    } catch (_error) {
      return Err(
        new BudgetRunServiceError({
          message: "Failed to get budget run by idempotency key",
        })
      )
    }
  }
}
