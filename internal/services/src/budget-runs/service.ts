import type { ApiResult } from "@unprice/api"
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
import type { BudgetRun, Customer, RunSummary, SearchParamsDataTable } from "@unprice/db/validators"
import { BaseError, Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { fromCurrencyMinor, toLedgerMinor } from "@unprice/money"
import type { Cache } from "../cache"
import type { ServiceContext } from "../context"
import { cachedQuery } from "../utils/cached-query"

type BudgetRunWorkloadType = "agent" | "workflow" | "job" | "tool" | "custom"

/**
 * Port for reading the authoritative run summary from the RunBudget DO via the
 * public SDK (`unprice.runs.get`). Injected per-call so construction sites don't
 * need an SDK client wired into the service graph.
 */
export type RunsGet = (input: {
  runId: string
  project_id?: string
}) => Promise<ApiResult<RunSummary>>

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

type UpdateRunSummaryInput = {
  projectId: string
  runId: string
  statusReason?: string | null
  consumedAmount: number
  remainingAmount: number
} & (
  | { status: "running"; endedAt?: null }
  | { status: Exclude<BudgetRunStatus, "running">; endedAt: Date }
)

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
  }): Promise<Result<{ runs: BudgetRunWithCustomer[]; pageCount: number }, BudgetRunServiceError>> {
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

  async listCustomerRuns(
    services: Pick<ServiceContext, "customers">,
    input: {
      customerId: string
      projectId: string
      query: SearchParamsDataTable
    }
  ): Promise<
    Result<{ customer: Customer; runs: BudgetRun[]; pageCount: number } | null, FetchError>
  > {
    const { customerId, projectId, query } = input

    const customerResult = await services.customers.getCustomerByIdInProject({
      id: customerId,
      projectId,
    })

    if (customerResult.err) {
      return Err(customerResult.err)
    }

    const customer = customerResult.val

    if (!customer) {
      return Ok(null)
    }

    const runColumns = getTableColumns(budgetRuns)
    const runStatusValues = new Set<BudgetRunStatus>([
      "running",
      "completed",
      "expired",
      "canceled",
      "budget_exceeded",
      "failed",
    ])
    const filter = `%${query.search ?? ""}%`
    const statusFilters =
      query.filters.status?.filter(
        (value): value is BudgetRunStatus =>
          typeof value === "string" && runStatusValues.has(value as BudgetRunStatus)
      ) ?? []

    try {
      const { data, total } = await this.deps.db.transaction(async (tx) => {
        const expressions = [
          eq(runColumns.customerId, customerId),
          eq(runColumns.projectId, projectId),
          query.search
            ? or(
                ilike(runColumns.id, filter),
                ilike(runColumns.traceId, filter),
                ilike(runColumns.workloadId, filter)
              )
            : undefined,
          statusFilters.length > 0 ? inArray(runColumns.status, statusFilters) : undefined,
        ]
        const startedFrom = query.from !== null ? new Date(query.from) : null
        const startedTo = query.to !== null ? new Date(query.to) : null
        const whereQuery = and(
          and(...expressions),
          startedFrom && startedTo
            ? between(runColumns.startedAt, startedFrom, startedTo)
            : undefined,
          startedFrom ? gte(runColumns.startedAt, startedFrom) : undefined,
          startedTo ? lte(runColumns.startedAt, startedTo) : undefined
        ) as SQL<BudgetRun>
        const runQuery = tx.select().from(budgetRuns).$dynamic()

        const data = await withPagination(
          runQuery,
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
          query.page,
          query.page_size
        )

        const total = await tx
          .select({
            count: count(),
          })
          .from(budgetRuns)
          .where(whereQuery)
          .execute()
          .then((res) => res[0]?.count ?? 0)

        return { data, total }
      })

      return Ok({
        customer,
        runs: data as BudgetRun[],
        pageCount: Math.ceil(total / query.page_size),
      })
    } catch (error) {
      const fetchError = new FetchError({
        message: `error getting customer runs: ${
          error instanceof Error ? error.message : String(error)
        }`,
        retry: false,
      })

      this.deps.logger.error(fetchError, {
        context: "error getting customer runs",
        customerId,
        projectId,
      })

      return Err(fetchError)
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

  async updateRunSummary(
    input: UpdateRunSummaryInput
  ): Promise<Result<BudgetRunRow, BudgetRunServiceError>> {
    if (
      input.status !== "running" &&
      (!(input.endedAt instanceof Date) || Number.isNaN(input.endedAt.getTime()))
    ) {
      return Err(
        new BudgetRunServiceError({
          message: "Terminal run summary requires endedAt",
        })
      )
    }

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

  /**
   * Refresh the Postgres read-model rows for any runs still marked `running` by
   * observing the RunBudget DO (the source of truth) through the injected
   * `runsGet` port.
   *
   * The DO cannot invalidate the `budgetRun` cache — it is memory-first per
   * isolate (5 min fresh / 1h stale) and the DO runs in a different isolate. So
   * when the observed run has newly gone terminal, the row is persisted here
   * via {@link updateRunSummary}, the single writer that both updates Postgres
   * AND invalidates that cache.
   *
   * Money is converted from the SDK's currency-minor units to internal ledger
   * scale (`toLedgerMinor(fromCurrencyMinor(...))`). Any identity mismatch
   * (customer / run id / currency) or read error keeps the stale row untouched
   * and persists nothing — a refresh must never rewrite a row it can't trust.
   *
   * `runsGet` is a METHOD parameter (not a constructor dep) so construction
   * sites don't need to wire an SDK client. `T` is preserved (spread `...run`)
   * so callers that carry extra fields — e.g. `{ customer }` — keep them.
   */
  async listRunsRefreshed<T extends BudgetRun>(input: {
    projectId: string
    customerId?: string
    runs: T[]
    runsGet: RunsGet
  }): Promise<T[]> {
    return Promise.all(
      input.runs.map(async (run) => {
        if (run.status !== "running") {
          return run
        }

        const expectedCustomerId = input.customerId ?? run.customerId
        const { result: live, error } = await input.runsGet({
          runId: run.id,
          project_id: input.projectId,
        })

        if (error || !live) {
          this.deps.logger.error(new Error(error?.message ?? "Failed to refresh running run"), {
            project_id: input.projectId,
            customer_id: expectedCustomerId,
            run_id: run.id,
          })
          return run
        }

        if (live.customerId !== expectedCustomerId) {
          this.deps.logger.error(new Error("Refreshed run customer mismatch"), {
            project_id: input.projectId,
            customer_id: expectedCustomerId,
            run_id: run.id,
          })
          return run
        }

        if (live.runId !== run.id) {
          this.deps.logger.error(new Error("Refreshed run id mismatch"), {
            project_id: input.projectId,
            customer_id: expectedCustomerId,
            run_id: run.id,
          })
          return run
        }

        if (live.currency !== run.currency) {
          this.deps.logger.error(new Error("Refreshed run currency mismatch"), {
            project_id: input.projectId,
            customer_id: expectedCustomerId,
            run_id: run.id,
          })
          return run
        }

        const budgetAmount = toLedgerMinor(fromCurrencyMinor(live.budgetAmountMinor, live.currency))
        const consumedAmount = toLedgerMinor(
          fromCurrencyMinor(live.consumedAmountMinor, live.currency)
        )
        const remainingAmount = toLedgerMinor(
          fromCurrencyMinor(live.remainingAmountMinor, live.currency)
        )

        // Newly terminal: the DO closed this run since Postgres was last written.
        // Persist through updateRunSummary so the read model AND its cache are
        // refreshed. AWAIT (never waitUntil): the sweep runs with a no-op
        // waitUntil, so a deferred write there would be silently dropped.
        if (live.status !== "running") {
          // During a rolling deployment an older public API can return a
          // terminal summary without the newly-added DO timestamp. Never invent
          // an observation time: leave the PG row running so the next sweep
          // retries after the API/DO rollout converges.
          if (live.endedAt == null) {
            this.deps.logger.error(
              new Error("Refreshed terminal run is missing its authoritative terminal timestamp"),
              {
                project_id: input.projectId,
                customer_id: expectedCustomerId,
                run_id: run.id,
              }
            )
            return run
          }

          const endedAt = new Date(live.endedAt)
          const persisted = await this.updateRunSummary({
            projectId: input.projectId,
            runId: run.id,
            status: live.status,
            consumedAmount,
            remainingAmount,
            endedAt,
          })

          if (persisted.err) {
            this.deps.logger.error(
              new Error(`Failed to persist refreshed run summary: ${persisted.err.message}`),
              {
                project_id: input.projectId,
                customer_id: expectedCustomerId,
                run_id: run.id,
              }
            )
          }

          return {
            ...run,
            status: live.status,
            budgetAmount,
            consumedAmount,
            remainingAmount,
            endedAt,
          } as T
        }

        return {
          ...run,
          status: live.status,
          budgetAmount,
          consumedAmount,
          remainingAmount,
        } as T
      })
    )
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
