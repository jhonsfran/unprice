import * as currencies from "@dinero.js/currencies"
import {
  type Analytics,
  type Interval,
  type PageBrowserVisits,
  type PageOverview,
  prepareInterval,
  type statsSchema,
} from "@unprice/analytics"
import { type Database, and, between, count, eq } from "@unprice/db"
import { features, plans, subscriptions, versions } from "@unprice/db/schema"
import { currencySymbol } from "@unprice/db/utils"
import { calculateFlatPricePlan } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { add, dinero, toDecimal } from "dinero.js"
import type { z } from "zod"
import { toErrorContext } from "../utils/log-context"

type OverviewStats = z.infer<typeof statsSchema>
type PageCountryVisits = Awaited<ReturnType<Analytics["getCountryVisits"]>>["data"]

type VisitsPayload<T> = {
  data: T
  error?: string
}

export class AnalyticsService {
  private readonly db: Database
  private readonly logger: Logger
  private readonly analytics: Analytics

  constructor({
    db,
    logger,
    analytics,
  }: {
    db: Database
    logger: Logger
    analytics: Analytics
  }) {
    this.db = db
    this.logger = logger
    this.analytics = analytics
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
      this.logger.error("failed to fetch plans stats", {
        error: toErrorContext(err),
        projectId,
      })
      return Err(err)
    }

    const [totalPlans, totalSubscriptions, totalPlanVersions, totalFeatures] = val

    return Ok({
      totalPlans: {
        total: totalPlans?.count ?? 0,
        title: "Total Plans",
        description: `created in the last ${preparedInterval.label}`,
      },
      totalSubscriptions: {
        total: totalSubscriptions?.count ?? 0,
        title: "Total Subscriptions",
        description: `created in the last ${preparedInterval.label}`,
      },
      totalPlanVersions: {
        total: totalPlanVersions?.count ?? 0,
        title: "Total Plan Versions",
        description: `created in the last ${preparedInterval.label}`,
      },
      totalFeatures: {
        total: totalFeatures?.count ?? 0,
        title: "Total Features",
        description: `created in the last ${preparedInterval.label}`,
      },
    } as OverviewStats)
  }

  public async getOverviewStats({
    projectId,
    defaultCurrency,
    interval,
  }: {
    projectId: string
    defaultCurrency: keyof typeof currencies
    interval: Interval
  }): Promise<Result<OverviewStats, FetchError>> {
    const preparedInterval = prepareInterval(interval)

    const { val: subscriptions, err } = await wrapResult(
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
            with: {
              planVersion: {
                with: {
                  planFeatures: {
                    with: {
                      feature: true,
                    },
                  },
                },
              },
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
      this.logger.error("failed to fetch overview stats", {
        error: toErrorContext(err),
        projectId,
      })
      return Err(err)
    }

    const defaultDineroCurrency = currencies[defaultCurrency]

    let total = dinero({ amount: 0, currency: defaultDineroCurrency })

    const stats = {
      newSignups: {
        total: 0,
        title: "New Signups",
        description: `in the last ${preparedInterval.label}`,
      },
      totalRevenue: {
        total: 0,
        title: "Total Revenue",
        description: `in the last ${preparedInterval.label}`,
        unit: currencySymbol(defaultCurrency),
      },
      newSubscriptions: {
        total: 0,
        title: "New Subscriptions",
        description: `in the last ${preparedInterval.label}`,
      },
      newCustomers: {
        total: 0,
        title: "New Customers",
        description: `in the last ${preparedInterval.label}`,
      },
    }

    for (const subscription of subscriptions) {
      const planVersion = subscription.phases[0]?.planVersion

      if (!planVersion) {
        continue
      }

      const { err: priceErr, val } = calculateFlatPricePlan({
        planVersion,
        prorate: 1,
      })

      if (priceErr) {
        this.logger.warn("error calculating flat plan price for overview stats", {
          error: toErrorContext(priceErr),
          projectId,
        })
        continue
      }

      const price = val.dinero

      stats.newSignups.total += 1
      total = add(total, price)
      stats.newSubscriptions.total += 1
      stats.newCustomers.total += 1
    }

    const displayAmount = toDecimal(total, ({ value }: { value: number | string }) => Number(value))
    stats.totalRevenue.total = displayAmount

    return Ok(stats as OverviewStats)
  }

  public async getCountryVisits({
    projectId,
    pageId,
    intervalDays,
  }: {
    projectId: string
    pageId?: string
    intervalDays?: number
  }): Promise<Result<VisitsPayload<PageCountryVisits>, FetchError>> {
    if (!pageId || pageId === "_" || pageId === "") {
      return Ok({ data: [], error: "Page ID is required" })
    }

    const { val: page, err: pageErr } = await wrapResult(
      this.db.query.pages.findFirst({
        where: (table, { eq, and }) => and(eq(table.id, pageId), eq(table.projectId, projectId)),
      }),
      (error) =>
        new FetchError({
          message: `failed to query page for country visits: ${error.message}`,
          retry: false,
        })
    )

    if (pageErr) {
      this.logger.error("failed to query page for country visits", {
        error: toErrorContext(pageErr),
        projectId,
        pageId,
      })
      return Err(pageErr)
    }

    if (!page) {
      return Ok({ data: [], error: "Page not found" })
    }

    const days = intervalDays ?? 7

    const { val, err } = await wrapResult(
      this.analytics
        .getCountryVisits({
          page_id: page.id,
          interval_days: days,
          project_id: projectId,
        })
        .then((res) => res.data),
      (error) =>
        new FetchError({
          message: `failed to fetch country visits: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("failed to fetch country visits", {
        error: toErrorContext(err),
        projectId,
        pageId,
        intervalDays: days,
      })
      return Err(err)
    }

    return Ok({ data: val ?? [] })
  }

  public async getBrowserVisits({
    projectId,
    pageId,
    intervalDays,
  }: {
    projectId: string
    pageId?: string
    intervalDays?: number
  }): Promise<Result<VisitsPayload<PageBrowserVisits>, FetchError>> {
    if (!pageId || pageId === "_" || pageId === "") {
      return Ok({ data: [], error: "Page ID is required" })
    }

    const { val: page, err: pageErr } = await wrapResult(
      this.db.query.pages.findFirst({
        where: (table, { eq, and }) => and(eq(table.id, pageId), eq(table.projectId, projectId)),
      }),
      (error) =>
        new FetchError({
          message: `failed to query page for browser visits: ${error.message}`,
          retry: false,
        })
    )

    if (pageErr) {
      this.logger.error("failed to query page for browser visits", {
        error: toErrorContext(pageErr),
        projectId,
        pageId,
      })
      return Err(pageErr)
    }

    if (!page) {
      return Ok({ data: [], error: "Page not found" })
    }

    const days = intervalDays ?? 7

    const { val, err } = await wrapResult(
      this.analytics
        .getBrowserVisits({
          page_id: page.id,
          interval_days: days,
          project_id: projectId,
        })
        .then((res) => res.data),
      (error) =>
        new FetchError({
          message: `failed to fetch browser visits: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("failed to fetch browser visits", {
        error: toErrorContext(err),
        projectId,
        pageId,
        intervalDays: days,
      })
      return Err(err)
    }

    return Ok({ data: val ?? [] })
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

    const days = intervalDays ?? 7

    if (pageId === "all") {
      const { val, err } = await wrapResult(
        this.analytics
          .getPagesOverview({
            interval_days: days,
            project_id: projectId,
          })
          .then((res) => res.data),
        (error) =>
          new FetchError({
            message: `failed to fetch pages overview: ${error.message}`,
            retry: false,
          })
      )

      if (err) {
        this.logger.error("failed to fetch pages overview", {
          error: toErrorContext(err),
          projectId,
          intervalDays: days,
        })
        return Err(err)
      }

      return Ok({ data: val ?? [] })
    }

    const { val: page, err: pageErr } = await wrapResult(
      this.db.query.pages.findFirst({
        where: (table, { eq, and }) => and(eq(table.id, pageId), eq(table.projectId, projectId)),
      }),
      (error) =>
        new FetchError({
          message: `failed to query page for pages overview: ${error.message}`,
          retry: false,
        })
    )

    if (pageErr) {
      this.logger.error("failed to query page for pages overview", {
        error: toErrorContext(pageErr),
        projectId,
        pageId,
      })
      return Err(pageErr)
    }

    if (!page) {
      return Ok({ data: [], error: "Page not found" })
    }

    const { val, err } = await wrapResult(
      this.analytics
        .getPagesOverview({
          page_id: page.id,
          interval_days: days,
          project_id: projectId,
        })
        .then((res) => res.data),
      (error) =>
        new FetchError({
          message: `failed to fetch pages overview: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("failed to fetch pages overview", {
        error: toErrorContext(err),
        projectId,
        pageId,
        intervalDays: days,
      })
      return Err(err)
    }

    return Ok({ data: val ?? [] })
  }

  public async getRealtimeTicketCustomer({
    projectId,
    customerId,
  }: {
    projectId: string
    customerId: string
  }): Promise<Result<{ id: string; projectId: string } | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.customers.findFirst({
        where: (table, { and, eq }) =>
          and(eq(table.id, customerId), eq(table.projectId, projectId)),
        columns: {
          id: true,
          projectId: true,
        },
      }),
      (error) =>
        new FetchError({
          message: `failed to fetch customer for realtime ticket: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("failed to fetch customer for realtime ticket", {
        error: toErrorContext(err),
        projectId,
        customerId,
      })
      return Err(err)
    }

    return Ok(val ?? null)
  }
}
