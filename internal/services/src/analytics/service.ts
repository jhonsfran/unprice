import { type Interval, prepareInterval, type statsSchema } from "@unprice/analytics"
import { type Database, and, between, count, eq } from "@unprice/db"
import { features, plans, subscriptions, versions } from "@unprice/db/schema"
import type { Currency } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { BasinSql, BasinSqlError } from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import { currencySymbol } from "@unprice/money"
import { toDecimal } from "dinero.js"
import type { z } from "zod"
import type { LedgerGateway } from "../ledger"
import {
  type FeatureUsageRow,
  type JournalEventCursor,
  type JournalEventScope,
  type JournalWindow,
  type StatementScope,
  buildEventFacetsSql,
  buildEventTimelineSql,
  buildEventTotalsSql,
  buildFeatureUsageSql,
  buildRecentEventsSql,
  buildRejectedEventSql,
  buildRejectionsSql,
  buildStatementEventCountSql,
  buildStatementEventsSql,
  buildTopPayersSql,
  eventFacetSqlRowSchema,
  eventTimelineSqlRowSchema,
  eventTotalsSqlRowSchema,
  featureUsageSqlRowSchema,
  recentEventSqlRowSchema,
  rejectedEventSqlRowSchema,
  rejectionsSqlRowSchema,
  statementEventCountSqlRowSchema,
  statementEventSqlRowSchema,
  topPayersSqlRowSchema,
} from "./budget-journal"
import {
  type PageBrowserVisits,
  type PageCountryVisits,
  type PageDimension,
  type PageOverview,
  type PlansConversion,
  buildPageDimensionSql,
  buildPagesOverviewSql,
  buildPlansConversionSql,
  foldPagesOverview,
  foldPlansConversion,
  overviewBucket,
  pageDimensionRowSchema,
  pagesOverviewSqlRowSchema,
  plansConversionSqlRowSchema,
  webAnalyticsWindow,
} from "./web-analytics"

type OverviewStats = z.infer<typeof statsSchema>

type VisitsPayload<T> = {
  data: T
  error?: string
}

/**
 * Basin SQL without credentials is a deployment state, not a failure: the dashboard polls the
 * analytics cards, so it is logged once per process at warn instead of at error on every poll.
 */
let warnedBasinSqlNotConfigured = false

export class AnalyticsService {
  private readonly db: Database
  private readonly logger: Logger
  private readonly basinSql: BasinSql
  private readonly ledgerGateway: LedgerGateway

  constructor({
    db,
    logger,
    basinSql,
    ledgerGateway,
  }: {
    db: Database
    logger: Logger
    basinSql: BasinSql
    ledgerGateway: LedgerGateway
  }) {
    this.db = db
    this.logger = logger
    this.basinSql = basinSql
    this.ledgerGateway = ledgerGateway
  }

  public async getPlansStats({
    projectId,
    interval,
  }: {
    projectId: string
    interval: Interval
  }): Promise<Result<OverviewStats, FetchError>> {
    const preparedInterval = prepareInterval(interval)

    const { val, err } = await wrapResult(
      Promise.all([
        this.db
          .select({
            count: count(),
          })
          .from(plans)
          .where(
            and(
              eq(plans.projectId, projectId),
              between(plans.createdAtM, preparedInterval.start, preparedInterval.end)
            )
          )
          .then((rows) => rows[0] ?? { count: 0 }),
        this.db
          .select({
            count: count(),
          })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.projectId, projectId),
              between(subscriptions.createdAtM, preparedInterval.start, preparedInterval.end)
            )
          )
          .then((rows) => rows[0] ?? { count: 0 }),
        this.db
          .select({
            count: count(),
          })
          .from(versions)
          .where(
            and(
              eq(versions.projectId, projectId),
              between(versions.createdAtM, preparedInterval.start, preparedInterval.end)
            )
          )
          .then((rows) => rows[0] ?? { count: 0 }),
        this.db
          .select({
            count: count(),
          })
          .from(features)
          .where(
            and(
              eq(features.projectId, projectId),
              between(features.createdAtM, preparedInterval.start, preparedInterval.end)
            )
          )
          .then((rows) => rows[0] ?? { count: 0 }),
      ]),
      (error) =>
        new FetchError({
          message: `failed to fetch plans stats: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "failed to fetch plans stats",
        projectId,
      })
      return Err(err)
    }

    const [totalPlans, totalSubscriptions, totalPlanVersions, totalFeatures] = val

    return Ok({
      totalPlans: {
        total: totalPlans?.count ?? 0,
        title: "Total Plans",
        description: `created in the last ${preparedInterval.durationLabel}`,
      },
      totalSubscriptions: {
        total: totalSubscriptions?.count ?? 0,
        title: "Total Subscriptions",
        description: `created in the last ${preparedInterval.durationLabel}`,
      },
      totalPlanVersions: {
        total: totalPlanVersions?.count ?? 0,
        title: "Total Plan Versions",
        description: `created in the last ${preparedInterval.durationLabel}`,
      },
      totalFeatures: {
        total: totalFeatures?.count ?? 0,
        title: "Total Features",
        description: `created in the last ${preparedInterval.durationLabel}`,
      },
    } as OverviewStats)
  }

  public async getOverviewStats({
    projectId,
    defaultCurrency,
    interval,
  }: {
    projectId: string
    defaultCurrency: Currency
    interval: Interval
  }): Promise<Result<OverviewStats, FetchError>> {
    const preparedInterval = prepareInterval(interval)

    const { val, err } = await wrapResult(
      this.db.query.subscriptions.findMany({
        where: (table, { eq }) => eq(table.projectId, projectId),
        columns: {
          id: true,
        },
        with: {
          customer: {
            columns: {
              id: true,
            },
          },
          phases: {
            columns: {
              id: true,
            },
            where: (table, { lte, and, isNull, gte, or }) =>
              and(
                gte(table.startAt, preparedInterval.start),
                or(isNull(table.endAt), lte(table.endAt, preparedInterval.end))
              ),
          },
        },
      }),
      (error) =>
        new FetchError({
          message: `failed to fetch overview stats: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "failed to fetch overview stats",
        projectId,
      })
      return Err(err)
    }

    const subscriptions = val
    const recognizedRevenue = await this.ledgerGateway.getRecognizedRevenue({
      projectId,
      currency: defaultCurrency,
      start: new Date(preparedInterval.start),
      end: new Date(preparedInterval.end),
    })

    const stats = {
      newSignups: {
        total: 0,
        title: "New Signups",
        description: `in the last ${preparedInterval.durationLabel}`,
      },
      totalRevenue: {
        total: 0,
        title: "Recognized revenue",
        description: `in the last ${preparedInterval.durationLabel}`,
        unit: currencySymbol(defaultCurrency),
      },
      newSubscriptions: {
        total: 0,
        title: "New Subscriptions",
        description: `in the last ${preparedInterval.durationLabel}`,
      },
      newCustomers: {
        total: 0,
        title: "New Customers",
        description: `in the last ${preparedInterval.durationLabel}`,
      },
    }

    if (recognizedRevenue.err) {
      this.logger.error(recognizedRevenue.err, {
        context: "failed to fetch recognized revenue for overview stats",
        projectId,
      })
      return Err(
        new FetchError({
          message: `failed to fetch overview stats: ${recognizedRevenue.err.message}`,
          retry: false,
        })
      )
    }

    for (const subscription of subscriptions) {
      if (!subscription.phases[0]) {
        continue
      }

      stats.newSignups.total += 1
      stats.newSubscriptions.total += 1
      stats.newCustomers.total += 1
    }

    const displayAmount = toDecimal(
      recognizedRevenue.val,
      ({
        value,
      }: {
        value: number | string
      }) => Number(value)
    )
    stats.totalRevenue.total = displayAmount

    return Ok(stats as OverviewStats)
  }

  public async getCountryVisits(opts: {
    projectId: string
    pageId?: string
    intervalDays?: number
  }): Promise<Result<VisitsPayload<PageCountryVisits>, FetchError>> {
    return this.getPageDimensionVisits({ ...opts, dimension: "country" })
  }

  public async getBrowserVisits(opts: {
    projectId: string
    pageId?: string
    intervalDays?: number
  }): Promise<Result<VisitsPayload<PageBrowserVisits>, FetchError>> {
    return this.getPageDimensionVisits({ ...opts, dimension: "browser" })
  }

  public async getPagesOverview({
    projectId,
    pageId,
    intervalDays,
  }: {
    projectId: string
    pageId?: string
    intervalDays?: number
  }): Promise<Result<VisitsPayload<PageOverview>, FetchError>> {
    if (!pageId) {
      return Ok({ data: [], error: "Page ID is required" })
    }

    let filterPageId: string | undefined
    if (pageId !== "all") {
      const page = await this.findPage({ projectId, pageId })
      if (page.err) {
        return page
      }
      if (!page.val) {
        return Ok({ data: [], error: "Page not found" })
      }
      filterPageId = page.val.id
    }

    const days = intervalDays ?? 7
    const window = webAnalyticsWindow(Date.now(), days)
    const bucket = overviewBucket(days)

    const rows = await this.query(
      buildPagesOverviewSql({ projectId, pageId: filterPageId, bucket, window }),
      pagesOverviewSqlRowSchema,
      { context: "failed to fetch pages overview", projectId, pageId, intervalDays: days }
    )
    if (rows.err) {
      return rows
    }

    return Ok({ data: foldPagesOverview(rows.val, { window, bucket, pageId: filterPageId }) })
  }

  public async getPlansConversion({
    projectId,
    intervalDays,
  }: {
    projectId: string
    intervalDays?: number
  }): Promise<Result<VisitsPayload<PlansConversion>, FetchError>> {
    const days = intervalDays ?? 7
    const rows = await this.query(
      buildPlansConversionSql({ projectId, window: webAnalyticsWindow(Date.now(), days) }),
      plansConversionSqlRowSchema,
      { context: "failed to fetch plans conversion", projectId, intervalDays: days }
    )
    if (rows.err) {
      return rows
    }

    return Ok({ data: foldPlansConversion(rows.val) })
  }

  // ---- usage history: the budget journal (ADR-0008 D7) ----

  /** Quantity and amount per feature the project's payer budgets consumed in the window. */
  public async getFeatureUsage(opts: {
    projectId: string
    customerId?: string
    window: JournalWindow
    bucket?: "hour" | "day"
    byCustomer?: boolean
  }): Promise<Result<FeatureUsageRow[], FetchError>> {
    return this.query(buildFeatureUsageSql(opts), featureUsageSqlRowSchema, {
      context: "failed to read feature usage from the budget journal",
      projectId: opts.projectId,
      customerId: opts.customerId,
    })
  }

  /** The payer budgets that consumed the most in the window. */
  public async getTopPayers(opts: { projectId: string; window: JournalWindow; limit: number }) {
    return this.query(buildTopPayersSql(opts), topPayersSqlRowSchema, {
      context: "failed to read top payers from the budget journal",
      projectId: opts.projectId,
    })
  }

  public async getEventTotals(scope: JournalEventScope) {
    return this.query(buildEventTotalsSql(scope), eventTotalsSqlRowSchema, {
      context: "failed to read event totals from the budget journal",
      projectId: scope.projectId,
    })
  }

  public async getEventTimeline(scope: JournalEventScope) {
    return this.query(buildEventTimelineSql(scope), eventTimelineSqlRowSchema, {
      context: "failed to read the event timeline from the budget journal",
      projectId: scope.projectId,
    })
  }

  public async getRejections(scope: JournalEventScope & { limit: number }) {
    return this.query(buildRejectionsSql(scope), rejectionsSqlRowSchema, {
      context: "failed to read rejections from the budget journal",
      projectId: scope.projectId,
    })
  }

  public async getRecentEvents(
    scope: JournalEventScope & { limit: number; cursor?: JournalEventCursor | null }
  ) {
    return this.query(buildRecentEventsSql(scope), recentEventSqlRowSchema, {
      context: "failed to read recent events from the budget journal",
      projectId: scope.projectId,
    })
  }

  public async getEventFacets(scope: JournalEventScope & { limit: number }) {
    return this.query(buildEventFacetsSql(scope), eventFacetSqlRowSchema, {
      context: "failed to read event facets from the budget journal",
      projectId: scope.projectId,
    })
  }

  /** One refused event as the API journaled it; null when the journal has no such row yet. */
  public async getRejectedEvent(opts: {
    projectId: string
    customerId: string
    operationId: string
    handledAt: number
  }) {
    const rows = await this.query(buildRejectedEventSql(opts), rejectedEventSqlRowSchema, {
      context: "failed to read a rejected event from the budget journal",
      projectId: opts.projectId,
      operationId: opts.operationId,
    })
    if (rows.err) {
      return rows
    }
    return Ok(rows.val[0] ?? null)
  }

  /**
   * A page of the events one statement counted, newest first, and how many it counted in all: a
   * separate count, so a page past the last event still reports the total.
   */
  public async getStatementEvents(
    opts: StatementScope & { limit: number; offset: number }
  ): Promise<
    Result<{ events: z.infer<typeof statementEventSqlRowSchema>[]; total: number }, FetchError>
  > {
    const logFields = {
      context: "failed to read statement events from the budget journal",
      projectId: opts.projectId,
      periodId: opts.periodId,
    }
    const [events, count] = await Promise.all([
      this.query(buildStatementEventsSql(opts), statementEventSqlRowSchema, logFields),
      this.query(buildStatementEventCountSql(opts), statementEventCountSqlRowSchema, logFields),
    ])
    if (events.err) return Err(events.err)
    if (count.err) return Err(count.err)
    return Ok({ events: events.val, total: count.val[0]?.events ?? 0 })
  }

  private async getPageDimensionVisits<D extends PageDimension>({
    projectId,
    pageId,
    intervalDays,
    dimension,
  }: {
    projectId: string
    pageId?: string
    intervalDays?: number
    dimension: D
  }): Promise<
    Result<
      VisitsPayload<({ page_id: string; visits: number; hits: number } & Record<D, string>)[]>,
      FetchError
    >
  > {
    // "_" and "all" are the dashboard's no-page selections; these cards need one page.
    if (!pageId || pageId === "_" || pageId === "all") {
      return Ok({ data: [], error: "Page ID is required" })
    }

    const page = await this.findPage({ projectId, pageId })
    if (page.err) {
      return page
    }
    if (!page.val) {
      return Ok({ data: [], error: "Page not found" })
    }

    const days = intervalDays ?? 7
    const rows = await this.query(
      buildPageDimensionSql({
        projectId,
        pageId: page.val.id,
        dimension,
        window: webAnalyticsWindow(Date.now(), days),
      }),
      pageDimensionRowSchema(dimension),
      { context: `failed to fetch ${dimension} visits`, projectId, pageId, intervalDays: days }
    )
    if (rows.err) {
      return rows
    }

    return Ok({ data: rows.val })
  }

  private async findPage({
    projectId,
    pageId,
  }: {
    projectId: string
    pageId: string
  }): Promise<Result<{ id: string } | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.pages.findFirst({
        columns: { id: true },
        where: (table, { eq, and }) => and(eq(table.id, pageId), eq(table.projectId, projectId)),
      }),
      (error) =>
        new FetchError({
          message: `failed to query page: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, { context: "failed to query page", projectId, pageId })
      return Err(err)
    }

    return Ok(val ?? null)
  }

  private async query<T>(
    sql: string,
    row: z.ZodType<T>,
    logFields: { context: string } & Record<string, unknown>
  ): Promise<Result<T[], FetchError>> {
    const result = await this.basinSql.query(sql, row)
    if (result.err) {
      this.logReadFailure(result.err, logFields)
      return Err(
        new FetchError({
          message: `${logFields.context}: ${result.err.message}`,
          retry: result.err.retry,
        })
      )
    }
    return Ok(result.val)
  }

  private logReadFailure(
    error: BasinSqlError,
    logFields: { context: string } & Record<string, unknown>
  ): void {
    if (error.code !== "NOT_CONFIGURED") {
      this.logger.error(error, logFields)
      return
    }
    if (!warnedBasinSqlNotConfigured) {
      warnedBasinSqlNotConfigured = true
      this.logger.warn(`Basin SQL reads are disabled: ${error.message}`, logFields)
    }
  }
}
