import type { Analytics } from "@unprice/analytics"
import { type Database, and, desc, eq, getTableColumns } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { nFormatter } from "@unprice/db/utils"
import {
  type BillingInterval,
  type Currency,
  type Customer,
  type Plan,
  type PlanVersion,
  type PlanVersionApi,
  type PlanVersionExtended,
  type Project,
  type Subscription,
  calculateFlatPricePlan,
  calculateFreeUnits,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { toErrorContext } from "../utils/log-context"
import { retry } from "../utils/retry"

export class PlanService {
  private readonly db: Database
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly metrics: Metrics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void

  private createCacheKey(prefix: string, params: Record<string, unknown>): string {
    // Sort keys to ensure consistent order
    const sortedParams = Object.keys(params)
      .sort()
      .reduce(
        (acc, key) => {
          acc[key] = params[key]
          return acc
        },
        {} as Record<string, unknown>
      )

    // Create a stable string representation
    const paramsString = JSON.stringify(sortedParams)
      .replace(/["'{}]/g, "")
      .replace(/,/g, "-")

    // Use a separator that's unlikely to appear in the data
    return `${prefix}:${paramsString}`
  }

  constructor({
    db,
    logger,
    analytics,
    waitUntil,
    cache,
    metrics,
  }: {
    db: Database
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
  }) {
    this.db = db
    this.logger = logger
    this.analytics = analytics
    this.waitUntil = waitUntil
    this.cache = cache
    this.metrics = metrics
  }

  private formatPlanVersion({
    planVersion,
  }: {
    planVersion: PlanVersionExtended & {
      plan: Plan
    }
  }): PlanVersionApi {
    const planFeatures = planVersion.planFeatures.map((planFeature) => {
      let displayFeatureText = ""

      const { val: freeUnits, err: freeUnitsErr } = calculateFreeUnits({
        config: planFeature.config!,
        featureType: planFeature.featureType,
      })

      if (freeUnitsErr) {
        console.error(freeUnitsErr)
        return {
          ...planFeature,
          displayFeatureText: "error calculating free units",
        }
      }

      const showUnits =
        planFeature.featureType === "usage" &&
        !planFeature.feature.slug.includes(planFeature.unitOfMeasure ?? "units")

      const freeUnitsText =
        freeUnits === Number.POSITIVE_INFINITY
          ? planFeature.limit
            ? `Up to ${nFormatter(planFeature.limit)} ${showUnits ? (planFeature.unitOfMeasure ?? "units") : ""}`
            : "Unlimited"
          : freeUnits === 0
            ? planFeature.limit
              ? `Up to ${nFormatter(planFeature.limit)} ${showUnits ? (planFeature.unitOfMeasure ?? "units") : ""}`
              : "Starts at 0"
            : `${nFormatter(freeUnits)} ${showUnits ? (planFeature.unitOfMeasure ?? "units") : ""}`

      switch (planFeature.featureType) {
        case "flat": {
          displayFeatureText = `${planFeature.feature.title}`
          break
        }

        case "tier": {
          displayFeatureText = `${freeUnitsText} ${planFeature.feature.title}`
          break
        }

        case "usage": {
          displayFeatureText = `${freeUnitsText} ${planFeature.feature.title}`

          break
        }

        case "package": {
          displayFeatureText = `${freeUnitsText} ${planFeature.feature.title}`
          break
        }
      }

      return {
        ...planFeature,
        displayFeatureText,
      }
    })

    // calculate flat price
    // verify if the payment method is required
    const { err, val: totalPricePlan } = calculateFlatPricePlan({
      planVersion,
    })

    if (err) {
      throw err
    }

    return {
      ...planVersion,
      flatPrice: totalPricePlan.displayAmount,
      planFeatures,
    }
  }

  private async getPlanVersionData({
    projectId,
    planVersionId,
  }: {
    projectId?: string
    planVersionId: string
  }): Promise<PlanVersionApi | null> {
    const start = performance.now()

    const planVersionData = await this.db.query.versions.findFirst({
      with: {
        plan: true,
        planFeatures: {
          with: {
            feature: true,
          },
          orderBy(fields, operators) {
            return operators.asc(fields.order)
          },
        },
      },
      where: (version, { and, eq }) =>
        and(
          projectId ? eq(version.projectId, projectId) : undefined,
          eq(version.id, planVersionId),
          eq(version.active, true),
          eq(version.status, "published")
        ),
    })

    const end = performance.now()

    this.metrics.emit({
      metric: "metric.db.read",
      query: "getPlanVersion",
      duration: end - start,
      service: "plans",
      projectId,
    })

    if (!planVersionData) {
      return null
    }

    // format plan
    return this.formatPlanVersion({
      planVersion: planVersionData,
    })
  }

  private async listPlanVersionsData({
    projectId,
    query,
  }: {
    projectId: string
    query: {
      published?: boolean
      latest?: boolean
      currency?: Currency
      billingInterval?: BillingInterval
      enterprise?: boolean
      planVersionIds?: string[]
    }
  }): Promise<PlanVersionApi[] | null> {
    const { published, latest, currency, enterprise, billingInterval, planVersionIds } = query
    const start = performance.now()

    const planVersionsData = await this.db.query.versions
      .findMany({
        with: {
          plan: true,
          planFeatures: {
            with: {
              feature: true,
            },
            orderBy(fields, operators) {
              return operators.asc(fields.order)
            },
          },
        },
        where: (version, { and, eq, inArray }) =>
          and(
            eq(version.projectId, projectId),
            eq(version.active, true),
            // get published versions by default, only get unpublished versions if the user wants it
            (published && eq(version.status, "published")) || undefined,
            // latest versions by default, only get non latest versions if the user wants it
            (latest && eq(version.latest, true)) || undefined,
            // filter by currency if provided
            currency ? eq(version.currency, currency) : undefined,
            // filter by plan version ids if provided
            planVersionIds && planVersionIds.length > 0
              ? inArray(version.id, planVersionIds)
              : undefined
          ),
      })
      .then((data) => {
        if (billingInterval) {
          return data.filter((version) => version.billingConfig.billingInterval === billingInterval)
        }

        return data
      })

    const end = performance.now()

    this.metrics.emit({
      metric: "metric.db.read",
      query: "listPlanVersionsData",
      duration: end - start,
      service: "plans",
      projectId,
    })

    if (planVersionsData.length === 0) {
      return null
    }

    const filtered = enterprise
      ? planVersionsData.filter((version) => version.plan.enterprisePlan)
      : planVersionsData

    // format every plan
    const result = filtered.map((version) => {
      return this.formatPlanVersion({
        planVersion: version,
      })
    })

    return result
  }

  public async listPlanVersions({
    projectId,
    query,
    opts,
  }: {
    projectId: string
    query: {
      published?: boolean
      latest?: boolean
      currency?: Currency
      billingInterval?: BillingInterval
      enterprise?: boolean
      limit?: number
      planVersionIds?: string[]
    }
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
    }
  }): Promise<Result<PlanVersionApi[] | null, FetchError>> {
    const cachekey = this.createCacheKey(projectId, query)

    // first try to get the entitlement from cache
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.listPlanVersionsData({
            projectId,
            query,
          }),
          (err) =>
            new FetchError({
              message: `unable to query list plans from db, ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                projectId,
                method: "listPlanVersions",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.planVersionList.swr(`${cachekey}`, () =>
              this.listPlanVersionsData({
                projectId,
                query,
              })
            ),
          (attempt, err) => {
            this.logger.warn("Failed to fetch list of plans data from cache, retrying...", {
              projectId,
              attempt,
              error: err.message,
            })
          }
        )

    if (err) {
      this.logger.error("error getting list of plans", {
        error: toErrorContext(err),
      })

      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    if (!val) {
      return Ok(null)
    }

    return Ok(val)
  }

  public async getPlanVersion({
    projectId,
    planVersionId,
    opts,
  }: {
    projectId?: string
    planVersionId: string
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
    }
  }): Promise<Result<PlanVersionApi | null, FetchError>> {
    const cachekey = `${planVersionId}`

    // first try to get the entitlement from cache
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getPlanVersionData({
            projectId,
            planVersionId,
          }),
          (err) =>
            new FetchError({
              message: `unable to query get plan from db, ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                projectId,
                method: "getPlanVersion",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.planVersion.swr(`${cachekey}`, () =>
              this.getPlanVersionData({
                projectId,
                planVersionId,
              })
            ),
          (attempt, err) => {
            this.logger.warn("Failed to fetch plan version data from cache, retrying...", {
              projectId,
              attempt,
              error: err.message,
            })
          }
        )

    if (err) {
      this.logger.error("error getting plan version", {
        error: toErrorContext(err),
      })

      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    if (!val) {
      return Ok(null)
    }

    return Ok(val)
  }

  public async getPlanById({
    id,
    projectId,
  }: {
    id: string
    projectId: string
  }): Promise<Result<(Plan & { versions: PlanVersion[]; project: Project }) | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.plans.findFirst({
        with: {
          versions: {
            orderBy: (version, { desc }) => [desc(version.createdAtM)],
          },
          project: true,
        },
        where: (plan, { eq, and }) => and(eq(plan.id, id), eq(plan.projectId, projectId)),
      }),
      (error) =>
        new FetchError({
          message: `error getting plan by id: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting plan by id", {
        error: toErrorContext(err),
        planId: id,
        projectId,
      })
      return Err(err)
    }

    return Ok((val as (Plan & { versions: PlanVersion[]; project: Project }) | null) ?? null)
  }

  public async getPlanBySlug({
    slug,
    projectId,
  }: {
    slug: string
    projectId: string
  }): Promise<Result<Plan | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.plans.findFirst({
        where: (plan, { eq, and }) => and(eq(plan.slug, slug), eq(plan.projectId, projectId)),
      }),
      (error) =>
        new FetchError({
          message: `error getting plan by slug: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting plan by slug", {
        error: toErrorContext(err),
        slug,
        projectId,
      })
      return Err(err)
    }

    return Ok((val as Plan | null) ?? null)
  }

  public async listPlansByProject({
    projectId,
    fromDate,
    toDate,
    published,
    active,
  }: {
    projectId: string
    fromDate?: number
    toDate?: number
    published?: boolean
    active?: boolean
  }): Promise<
    Result<
      Array<
        Plan & {
          versions: Array<Pick<PlanVersion, "id" | "status" | "title" | "currency" | "version">>
        }
      >,
      FetchError
    >
  > {
    const needsPublished = published === undefined || published
    const needsActive = active === undefined || active

    const { val, err } = await wrapResult(
      this.db.query.plans.findMany({
        with: {
          versions: {
            where: (version, { eq }) =>
              needsPublished ? eq(version.status, "published") : undefined,
            orderBy: (version, { asc }) => [asc(version.version)],
            columns: {
              status: true,
              id: true,
              title: true,
              currency: true,
              version: true,
            },
          },
        },
        where: (plan, { eq, and, between, gte, lte }) =>
          and(
            eq(plan.projectId, projectId),
            fromDate && toDate ? between(plan.createdAtM, fromDate, toDate) : undefined,
            fromDate ? gte(plan.createdAtM, fromDate) : undefined,
            toDate ? lte(plan.createdAtM, toDate) : undefined,
            needsActive ? eq(plan.active, true) : undefined
          ),
        orderBy: (plan, { asc }) => [asc(plan.createdAtM)],
      }),
      (error) =>
        new FetchError({
          message: `error listing plans by project: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error listing plans by project", {
        error: toErrorContext(err),
        projectId,
      })
      return Err(err)
    }

    return Ok(
      (val as Array<
        Plan & {
          versions: Array<Pick<PlanVersion, "id" | "status" | "title" | "currency" | "version">>
        }
      >) ?? []
    )
  }

  public async planExists({
    slug,
    id,
    projectId,
  }: {
    slug: string
    id?: string
    projectId: string
  }): Promise<Result<boolean, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.plans.findFirst({
        columns: {
          id: true,
        },
        where: (plan, { eq, and }) =>
          id
            ? and(eq(plan.projectId, projectId), eq(plan.id, id))
            : and(eq(plan.projectId, projectId), eq(plan.slug, slug)),
      }),
      (error) =>
        new FetchError({
          message: `error checking plan exists: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error checking plan exists", {
        error: toErrorContext(err),
        projectId,
        slug,
      })
      return Err(err)
    }

    return Ok(Boolean(val))
  }

  public async getPlanWithVersionsBySlug({
    slug,
    projectId,
  }: {
    slug: string
    projectId: string
  }): Promise<
    Result<
      | (Plan & {
          versions: Array<
            PlanVersion & {
              subscriptions: number
              plan: Pick<Plan, "defaultPlan">
            }
          >
        })
      | null,
      FetchError
    >
  > {
    const { val, err } = await wrapResult(
      this.db.query.plans
        .findFirst({
          with: {
            versions: {
              orderBy: (version, { desc }) => [desc(version.createdAtM)],
              with: {
                phases: {
                  columns: {
                    id: true,
                    subscriptionId: true,
                  },
                },
                plan: {
                  columns: {
                    defaultPlan: true,
                  },
                },
              },
            },
          },
          where: (plan, { eq, and }) => and(eq(plan.slug, slug), eq(plan.projectId, projectId)),
        })
        .then((plan) => {
          if (!plan) {
            return null
          }

          return {
            ...plan,
            versions: plan.versions.map((version) => ({
              ...version,
              subscriptions: version.phases.length,
            })),
          }
        }),
      (error) =>
        new FetchError({
          message: `error getting plan versions by slug: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting plan versions by slug", {
        error: toErrorContext(err),
        projectId,
        slug,
      })
      return Err(err)
    }

    return Ok(
      (val as
        | (Plan & {
            versions: Array<
              PlanVersion & {
                subscriptions: number
                plan: Pick<Plan, "defaultPlan">
              }
            >
          })
        | null) ?? null
    )
  }

  public async getPlanSubscriptionsBySlug({
    slug,
    projectId,
  }: {
    slug: string
    projectId: string
  }): Promise<
    Result<
      {
        plan: Plan | null
        subscriptions: Array<Subscription & { customer: Customer }>
      },
      FetchError
    >
  > {
    const customerColumns = getTableColumns(schema.customers)

    const { val, err } = await wrapResult(
      Promise.all([
        this.db.query.plans.findFirst({
          where: (plan, { eq, and }) => and(eq(plan.slug, slug), eq(plan.projectId, projectId)),
        }),
        this.db
          .selectDistinctOn([schema.subscriptions.id], {
            subscriptions: schema.subscriptions,
            customer: customerColumns,
          })
          .from(schema.plans)
          .innerJoin(
            schema.versions,
            and(
              eq(schema.versions.planId, schema.plans.id),
              eq(schema.versions.projectId, schema.plans.projectId)
            )
          )
          .innerJoin(
            schema.subscriptionPhases,
            and(
              eq(schema.versions.id, schema.subscriptionPhases.planVersionId),
              eq(schema.versions.projectId, schema.subscriptionPhases.projectId)
            )
          )
          .innerJoin(
            schema.subscriptions,
            and(
              eq(schema.subscriptions.id, schema.subscriptionPhases.subscriptionId),
              eq(schema.subscriptions.projectId, schema.subscriptionPhases.projectId)
            )
          )
          .innerJoin(
            schema.customers,
            and(
              eq(schema.customers.id, schema.subscriptions.customerId),
              eq(schema.customers.projectId, schema.subscriptions.projectId)
            )
          )
          .where(and(eq(schema.plans.slug, slug), eq(schema.plans.projectId, projectId)))
          .orderBy(() => [desc(schema.subscriptions.id)]),
      ]),
      (error) =>
        new FetchError({
          message: `error getting plan subscriptions by slug: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting plan subscriptions by slug", {
        error: toErrorContext(err),
        projectId,
        slug,
      })
      return Err(err)
    }

    const [plan, rows] = val
    const subscriptions = rows.map((data) => ({
      ...data.subscriptions,
      customer: data.customer,
    }))

    return Ok({
      plan: (plan as Plan | null) ?? null,
      subscriptions: subscriptions as Array<Subscription & { customer: Customer }>,
    })
  }
}
