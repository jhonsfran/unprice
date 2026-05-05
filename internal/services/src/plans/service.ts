import type { Analytics } from "@unprice/analytics"
import { type Database, and, desc, eq, getTableColumns, sql } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { nFormatter, newId } from "@unprice/db/utils"
import {
  type BillingInterval,
  type Currency,
  type Customer,
  type Feature,
  type Plan,
  type PlanVersion,
  type PlanVersionApi,
  type PlanVersionExtended,
  type PlanVersionFeature,
  type Project,
  type Subscription,
  calculateFlatPricePlan,
  calculateFreeUnits,
  configFlatSchema,
  configPackageSchema,
  configTierSchema,
  configUsageSchema,
  getAnchor,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { cachedQuery } from "../utils/cached-query"
import { toErrorContext } from "../utils/log-context"

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
    const { val, err } = await cachedQuery({
      skipCache: opts?.skipCache,
      cache: this.cache.planVersionList,
      cacheKey: `${cachekey}`,
      load: () =>
        this.listPlanVersionsData({
          projectId,
          query,
        }),
      wrapLoadError: (err) =>
        new FetchError({
          message: `unable to query list plans from db, ${err.message}`,
          retry: false,
          context: {
            error: err.message,
            url: "",
            projectId,
            method: "listPlanVersions",
          },
        }),
      onRetry: (attempt, err) => {
        this.logger.warn("Failed to fetch list of plans data from cache, retrying...", {
          projectId,
          attempt,
          error: toErrorContext(err),
        })
      },
    })

    if (err) {
      this.logger.error(err, {
        context: "error getting list of plans",
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
    const { val, err } = await cachedQuery({
      skipCache: opts?.skipCache,
      cache: this.cache.planVersion,
      cacheKey: `${cachekey}`,
      load: () =>
        this.getPlanVersionData({
          projectId,
          planVersionId,
        }),
      wrapLoadError: (err) =>
        new FetchError({
          message: `unable to query get plan from db, ${err.message}`,
          retry: false,
          context: {
            error: err.message,
            url: "",
            projectId,
            method: "getPlanVersion",
          },
        }),
      onRetry: (attempt, err) => {
        this.logger.warn("Failed to fetch plan version data from cache, retrying...", {
          projectId,
          attempt,
          error: toErrorContext(err),
        })
      },
    })

    if (err) {
      this.logger.error(err, {
        context: "error getting plan version",
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
      this.logger.error(err, {
        context: "error getting plan by id",
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
      this.logger.error(err, {
        context: "error getting plan by slug",
        slug,
        projectId,
      })
      return Err(err)
    }

    return Ok((val as Plan | null) ?? null)
  }

  public async removePlanRecord({
    projectId,
    id,
  }: {
    projectId: string
    id: string
  }): Promise<
    Result<{ state: "not_found" | "published_conflict" } | { state: "ok"; plan: Plan }, FetchError>
  > {
    const countPublishedVersions = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.versions)
      .where(
        and(
          eq(schema.versions.projectId, projectId),
          eq(schema.versions.planId, id),
          eq(schema.versions.status, "published")
        )
      )
      .then((res) => res[0]?.count ?? 0)

    if (countPublishedVersions > 0) {
      return Ok({
        state: "published_conflict",
      })
    }

    const { val, err } = await wrapResult(
      this.db
        .delete(schema.plans)
        .where(and(eq(schema.plans.projectId, projectId), eq(schema.plans.id, id)))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error removing plan: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error removing plan",
        projectId,
        planId: id,
      })
      return Err(err)
    }

    if (!val) {
      return Ok({
        state: "not_found",
      })
    }

    return Ok({
      state: "ok",
      plan: val as Plan,
    })
  }

  public async updatePlanRecord({
    projectId,
    id,
    description,
    active,
    title,
    defaultPlan,
    enterprisePlan,
  }: {
    projectId: string
    id: string
    description?: Plan["description"]
    active?: Plan["active"]
    title?: Plan["title"]
    defaultPlan?: Plan["defaultPlan"]
    enterprisePlan?: Plan["enterprisePlan"]
  }): Promise<
    Result<
      | {
          state:
            | "plan_not_found"
            | "default_enterprise_conflict"
            | "default_plan_exists"
            | "enterprise_plan_exists"
        }
      | {
          state: "ok"
          plan: Plan
        },
      FetchError
    >
  > {
    if (defaultPlan && enterprisePlan) {
      return Ok({
        state: "default_enterprise_conflict",
      })
    }

    const planData = await this.db.query.plans.findFirst({
      where: (plan, { eq, and }) => and(eq(plan.id, id), eq(plan.projectId, projectId)),
    })

    if (!planData?.id) {
      return Ok({
        state: "plan_not_found",
      })
    }

    if (defaultPlan) {
      const defaultPlanData = await this.db.query.plans.findFirst({
        where: (plan, { eq, and }) =>
          and(eq(plan.projectId, projectId), eq(plan.defaultPlan, true)),
      })

      if (defaultPlanData && defaultPlanData.id !== id) {
        return Ok({
          state: "default_plan_exists",
        })
      }
    }

    if (enterprisePlan) {
      const enterprisePlanData = await this.db.query.plans.findFirst({
        where: (plan, { eq, and }) =>
          and(eq(plan.projectId, projectId), eq(plan.enterprisePlan, true)),
      })

      if (enterprisePlanData && enterprisePlanData.id !== id) {
        return Ok({
          state: "enterprise_plan_exists",
        })
      }
    }

    const { val, err } = await wrapResult(
      this.db
        .update(schema.plans)
        .set({
          ...(title !== undefined && { title }),
          ...(description !== undefined && { description }),
          ...(active !== undefined && { active }),
          defaultPlan: defaultPlan ?? false,
          enterprisePlan: enterprisePlan ?? false,
          updatedAtM: Date.now(),
        })
        .where(and(eq(schema.plans.id, id), eq(schema.plans.projectId, projectId)))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error updating plan record: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error updating plan record",
        projectId,
        planId: id,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "Error updating plan",
          retry: false,
        })
      )
    }

    return Ok({
      state: "ok",
      plan: val as Plan,
    })
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
      this.logger.error(err, {
        context: "error listing plans by project",
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
      this.logger.error(err, {
        context: "error checking plan exists",
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
      this.logger.error(err, {
        context: "error getting plan versions by slug",
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
      this.logger.error(err, {
        context: "error getting plan subscriptions by slug",
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

  public async getPlanByIdRecord({
    planId,
    projectId,
  }: {
    planId: string
    projectId: string
  }): Promise<Result<Plan | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.plans.findFirst({
        where: (plan, { eq, and }) => and(eq(plan.id, planId), eq(plan.projectId, projectId)),
      }),
      (error) =>
        new FetchError({
          message: `error getting plan by id: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error getting plan by id",
        projectId,
        planId,
      })
      return Err(err)
    }

    return Ok((val as Plan | null) ?? null)
  }

  public async getPlanVersionByIdRecord({
    planVersionId,
    projectId,
  }: {
    planVersionId: string
    projectId: string
  }): Promise<Result<PlanVersion | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.versions.findFirst({
        where: (version, { and, eq }) =>
          and(eq(version.id, planVersionId), eq(version.projectId, projectId)),
      }),
      (error) =>
        new FetchError({
          message: `error getting plan version by id: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error getting plan version by id",
        projectId,
        planVersionId,
      })
      return Err(err)
    }

    return Ok((val as PlanVersion | null) ?? null)
  }

  public async getPlanVersionByIdDetailed({
    planVersionId,
    projectId,
  }: {
    planVersionId: string
    projectId: string
  }): Promise<
    Result<
      | (PlanVersion & {
          plan: Plan
          planFeatures: Array<unknown>
        })
      | null,
      FetchError
    >
  > {
    const { val, err } = await wrapResult(
      this.db.query.versions.findFirst({
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
          and(eq(version.projectId, projectId), eq(version.id, planVersionId)),
      }),
      (error) =>
        new FetchError({
          message: `error getting plan version by id with details: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error getting plan version by id with details",
        projectId,
        planVersionId,
      })
      return Err(err)
    }

    return Ok((val as (PlanVersion & { plan: Plan; planFeatures: Array<unknown> }) | null) ?? null)
  }

  public async getPlanVersionByIdForDuplication({
    planVersionId,
    projectId,
  }: {
    planVersionId: string
    projectId: string
  }): Promise<
    Result<
      | (PlanVersion & {
          planFeatures: Array<unknown>
          plan: Plan
        })
      | null,
      FetchError
    >
  > {
    const { val, err } = await wrapResult(
      this.db.query.versions.findFirst({
        where: (version, { and, eq }) =>
          and(eq(version.id, planVersionId), eq(version.projectId, projectId)),
        with: {
          planFeatures: true,
          plan: true,
        },
      }),
      (error) =>
        new FetchError({
          message: `error getting plan version for duplication: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error getting plan version for duplication",
        projectId,
        planVersionId,
      })
      return Err(err)
    }

    return Ok((val as (PlanVersion & { planFeatures: Array<unknown>; plan: Plan }) | null) ?? null)
  }

  public async createPlanVersionRecord({
    projectId,
    planId,
    metadata,
    description,
    currency,
    billingConfig,
    gracePeriod,
    title,
    tags,
    whenToBill,
    status,
    paymentProvider,
    trialUnits,
    autoRenew,
    collectionMethod,
    dueBehaviour,
    paymentMethodRequired,
    creditLineAmount,
  }: {
    projectId: string
    planId: string
    metadata: PlanVersion["metadata"]
    description: PlanVersion["description"]
    currency: PlanVersion["currency"]
    billingConfig: Omit<NonNullable<PlanVersion["billingConfig"]>, "billingAnchor"> & {
      billingAnchor?: number | "dayOfCreation"
    }
    gracePeriod?: PlanVersion["gracePeriod"]
    title: PlanVersion["title"]
    tags: PlanVersion["tags"]
    whenToBill: PlanVersion["whenToBill"]
    status?: PlanVersion["status"]
    paymentProvider: PlanVersion["paymentProvider"]
    trialUnits?: PlanVersion["trialUnits"]
    autoRenew?: PlanVersion["autoRenew"]
    collectionMethod?: PlanVersion["collectionMethod"]
    dueBehaviour?: PlanVersion["dueBehaviour"]
    paymentMethodRequired?: PlanVersion["paymentMethodRequired"]
    creditLineAmount?: PlanVersion["creditLineAmount"]
  }): Promise<
    Result<{ state: "plan_not_found" } | { state: "ok"; planVersion: PlanVersion }, FetchError>
  > {
    const planData = await this.db.query.plans.findFirst({
      where: (plan, { eq, and }) => and(eq(plan.id, planId), eq(plan.projectId, projectId)),
    })

    if (!planData?.id) {
      return Ok({ state: "plan_not_found" })
    }

    const planVersionId = newId("plan_version")

    const { val, err } = await wrapResult(
      this.db.transaction(async (tx) => {
        const countVersionsPlan = await tx
          .select({ count: sql<number>`count(*)` })
          .from(schema.versions)
          .where(and(eq(schema.versions.projectId, projectId), eq(schema.versions.planId, planId)))
          .then((res) => res[0]?.count ?? 0)

        return tx
          .insert(schema.versions)
          .values({
            id: planVersionId,
            planId,
            projectId,
            description,
            title,
            tags: tags ?? [],
            status: status ?? "draft",
            paymentProvider,
            currency,
            autoRenew,
            billingConfig: {
              ...billingConfig,
              billingAnchor: billingConfig.billingAnchor ?? "dayOfCreation",
            },
            trialUnits: trialUnits ?? 0,
            gracePeriod: gracePeriod ?? 0,
            whenToBill,
            collectionMethod: collectionMethod ?? "charge_automatically",
            dueBehaviour: dueBehaviour ?? "cancel",
            paymentMethodRequired: paymentMethodRequired ?? false,
            creditLineAmount: creditLineAmount ?? 0,
            metadata,
            version: Number(countVersionsPlan) + 1,
          })
          .returning()
          .then((rows) => rows[0] ?? null)
      }),
      (error) =>
        new FetchError({
          message: `error creating plan version: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error creating plan version",
        projectId,
        planId,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "error creating version",
          retry: false,
        })
      )
    }

    return Ok({
      state: "ok",
      planVersion: val as PlanVersion,
    })
  }

  public async updatePlanVersionRecord({
    projectId,
    id,
    status,
    description,
    currency,
    billingConfig,
    gracePeriod,
    title,
    tags,
    whenToBill,
    paymentProvider,
    metadata,
    autoRenew,
    trialUnits,
    collectionMethod,
    dueBehaviour,
    paymentMethodRequired,
    creditLineAmount,
  }: {
    projectId: string
    id: string
    status?: PlanVersion["status"]
    description?: PlanVersion["description"]
    currency?: PlanVersion["currency"]
    billingConfig?: PlanVersion["billingConfig"]
    gracePeriod?: PlanVersion["gracePeriod"]
    title?: PlanVersion["title"]
    tags?: PlanVersion["tags"]
    whenToBill?: PlanVersion["whenToBill"]
    paymentProvider?: PlanVersion["paymentProvider"]
    metadata?: PlanVersion["metadata"]
    autoRenew?: PlanVersion["autoRenew"]
    trialUnits?: PlanVersion["trialUnits"]
    collectionMethod?: PlanVersion["collectionMethod"]
    dueBehaviour?: PlanVersion["dueBehaviour"]
    paymentMethodRequired?: PlanVersion["paymentMethodRequired"]
    creditLineAmount?: PlanVersion["creditLineAmount"]
  }): Promise<
    Result<{ state: "not_found" } | { state: "ok"; planVersion: PlanVersion }, FetchError>
  > {
    const planVersionData = await this.db.query.versions.findFirst({
      with: {
        plan: {
          columns: {
            slug: true,
          },
        },
      },
      where: (version, { and, eq }) => and(eq(version.id, id), eq(version.projectId, projectId)),
    })

    if (!planVersionData?.id) {
      return Ok({ state: "not_found" })
    }

    if (planVersionData.status === "published") {
      const { val, err } = await wrapResult(
        this.db
          .update(schema.versions)
          .set({
            ...(description !== undefined && { description }),
            ...(status !== undefined && { status }),
            updatedAtM: Date.now(),
          })
          .where(and(eq(schema.versions.id, planVersionData.id)))
          .returning()
          .then((rows) => rows[0] ?? null),
        (error) =>
          new FetchError({
            message: `error updating published plan version: ${error.message}`,
            retry: false,
          })
      )

      if (err) {
        this.logger.error(err, {
          context: "error updating published plan version",
          projectId,
          planVersionId: id,
        })
        return Err(err)
      }

      if (!val) {
        return Err(
          new FetchError({
            message: "Error updating version",
            retry: false,
          })
        )
      }

      return Ok({
        state: "ok",
        planVersion: val as PlanVersion,
      })
    }

    const { val, err } = await wrapResult(
      this.db.transaction(async (tx) => {
        if (currency && currency !== planVersionData.currency) {
          const features = await tx.query.planVersionFeatures.findMany({
            where: (feature, { and, eq }) =>
              and(eq(feature.planVersionId, planVersionData.id), eq(feature.projectId, projectId)),
          })

          await Promise.all(
            features.map(async (feature) => {
              switch (feature.featureType) {
                case "flat": {
                  const config = configFlatSchema.parse(feature.config)
                  return tx
                    .update(schema.planVersionFeatures)
                    .set({
                      config: {
                        ...config,
                        price: {
                          ...config.price,
                          dinero: {
                            ...config.price.dinero,
                            currency: {
                              ...config.price.dinero.currency,
                              code: currency,
                            },
                          },
                        },
                      },
                    })
                    .where(and(eq(schema.planVersionFeatures.id, feature.id)))
                }
                case "tier": {
                  const config = configTierSchema.parse(feature.config)
                  return tx
                    .update(schema.planVersionFeatures)
                    .set({
                      config: {
                        ...config,
                        tiers: config.tiers.map((tier) => ({
                          ...tier,
                          unitPrice: {
                            ...tier.unitPrice,
                            dinero: {
                              ...tier.unitPrice.dinero,
                              currency: {
                                ...tier.unitPrice.dinero.currency,
                                code: currency,
                              },
                            },
                          },
                          flatPrice: {
                            ...tier.flatPrice,
                            dinero: {
                              ...tier.flatPrice.dinero,
                              currency: {
                                ...tier.flatPrice.dinero.currency,
                                code: currency,
                              },
                            },
                          },
                        })),
                      },
                    })
                    .where(and(eq(schema.planVersionFeatures.id, feature.id)))
                }
                case "usage": {
                  const config = configUsageSchema.parse(feature.config)
                  if (config.tiers && config.tiers.length > 0) {
                    return tx
                      .update(schema.planVersionFeatures)
                      .set({
                        config: {
                          ...config,
                          tiers: config.tiers.map((tier) => ({
                            ...tier,
                            unitPrice: {
                              ...tier.unitPrice,
                              dinero: {
                                ...tier.unitPrice.dinero,
                                currency: {
                                  ...tier.unitPrice.dinero.currency,
                                  code: currency,
                                },
                              },
                            },
                            flatPrice: {
                              ...tier.flatPrice,
                              dinero: {
                                ...tier.flatPrice.dinero,
                                currency: {
                                  ...tier.flatPrice.dinero.currency,
                                  code: currency,
                                },
                              },
                            },
                          })),
                        },
                      })
                      .where(and(eq(schema.planVersionFeatures.id, feature.id)))
                  }

                  if (config.price) {
                    return tx
                      .update(schema.planVersionFeatures)
                      .set({
                        config: {
                          ...config,
                          price: {
                            ...config.price,
                            dinero: {
                              ...config.price.dinero,
                              currency: {
                                ...config.price.dinero.currency,
                                code: currency,
                              },
                            },
                          },
                        },
                      })
                      .where(and(eq(schema.planVersionFeatures.id, feature.id)))
                  }

                  return undefined
                }
                case "package": {
                  const config = configPackageSchema.parse(feature.config)
                  return tx
                    .update(schema.planVersionFeatures)
                    .set({
                      config: {
                        ...config,
                        price: {
                          ...config.price,
                          dinero: {
                            ...config.price.dinero,
                            currency: {
                              ...config.price.dinero.currency,
                              code: currency,
                            },
                          },
                        },
                      },
                    })
                    .where(and(eq(schema.planVersionFeatures.id, feature.id)))
                }
                default:
                  return undefined
              }
            })
          )
        }

        return tx
          .update(schema.versions)
          .set({
            ...(description !== undefined && { description }),
            ...(currency !== undefined && { currency }),
            ...(billingConfig !== undefined && { billingConfig }),
            ...(gracePeriod !== undefined && { gracePeriod }),
            ...(title !== undefined && { title }),
            ...(tags !== undefined && { tags }),
            ...(whenToBill !== undefined && { whenToBill }),
            ...(autoRenew !== undefined && { autoRenew }),
            ...(status !== undefined && { status }),
            ...(metadata !== undefined && { metadata }),
            ...(paymentProvider !== undefined && { paymentProvider }),
            ...(trialUnits !== undefined && { trialUnits }),
            ...(collectionMethod !== undefined && { collectionMethod }),
            ...(dueBehaviour !== undefined && { dueBehaviour }),
            ...(paymentMethodRequired !== undefined && { paymentMethodRequired }),
            ...(creditLineAmount !== undefined && { creditLineAmount }),
            updatedAtM: Date.now(),
          })
          .where(and(eq(schema.versions.id, planVersionData.id)))
          .returning()
          .then((rows) => rows[0] ?? null)
      }),
      (error) =>
        new FetchError({
          message: `error updating draft plan version: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error updating draft plan version",
        projectId,
        planVersionId: id,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "Error updating version",
          retry: false,
        })
      )
    }

    return Ok({
      state: "ok",
      planVersion: val as PlanVersion,
    })
  }

  public async deactivatePlanVersionRecord({
    projectId,
    id,
  }: {
    projectId: string
    id: string
  }): Promise<
    Result<
      | { state: "not_found" | "not_published" | "already_deactivated" }
      | { state: "ok"; planVersion: PlanVersion },
      FetchError
    >
  > {
    const planVersionData = await this.db.query.versions.findFirst({
      where: (version, { and, eq }) => and(eq(version.id, id), eq(version.projectId, projectId)),
    })

    if (!planVersionData?.id) {
      return Ok({ state: "not_found" })
    }

    if (planVersionData.status !== "published") {
      return Ok({ state: "not_published" })
    }

    if (!planVersionData.active) {
      return Ok({ state: "already_deactivated" })
    }

    const { val, err } = await wrapResult(
      this.db.transaction(async (tx) => {
        let promise: Promise<unknown> | undefined

        if (planVersionData.latest) {
          const previousVersion = await tx.query.versions
            .findMany({
              where: (version, { and, eq }) =>
                and(
                  eq(version.projectId, projectId),
                  eq(version.planId, planVersionData.planId),
                  eq(version.status, "published"),
                  eq(version.latest, false),
                  eq(version.active, true)
                ),
              orderBy(fields, operators) {
                return operators.desc(fields.publishedAt)
              },
            })
            .then((data) => data[0])

          if (previousVersion?.id) {
            promise = tx
              .update(schema.versions)
              .set({
                latest: true,
              })
              .where(
                and(
                  eq(schema.versions.projectId, projectId),
                  eq(schema.versions.id, previousVersion.id)
                )
              )
          }
        }

        const [deactivated] = await Promise.all([
          tx
            .update(schema.versions)
            .set({
              active: false,
              latest: false,
              updatedAtM: Date.now(),
            })
            .where(and(eq(schema.versions.id, planVersionData.id)))
            .returning()
            .then((rows) => rows[0] ?? null),
          promise,
        ])

        return deactivated
      }),
      (error) =>
        new FetchError({
          message: `error deactivating plan version: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error deactivating plan version",
        projectId,
        planVersionId: id,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "Error deactivating version",
          retry: false,
        })
      )
    }

    return Ok({
      state: "ok",
      planVersion: val as PlanVersion,
    })
  }

  public async removePlanVersionRecord({
    projectId,
    id,
  }: {
    projectId: string
    id: string
  }): Promise<
    Result<
      { state: "not_found" | "published_conflict" } | { state: "ok"; planVersion: PlanVersion },
      FetchError
    >
  > {
    const planVersionData = await this.db.query.versions.findFirst({
      where: (version, { and, eq }) => and(eq(version.id, id), eq(version.projectId, projectId)),
    })

    if (!planVersionData?.id) {
      return Ok({ state: "not_found" })
    }

    if (planVersionData.status === "published") {
      return Ok({ state: "published_conflict" })
    }

    const { val, err } = await wrapResult(
      this.db
        .delete(schema.versions)
        .where(
          and(eq(schema.versions.projectId, projectId), eq(schema.versions.id, planVersionData.id))
        )
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error removing plan version: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error removing plan version",
        projectId,
        planVersionId: id,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "Error deleting version",
          retry: false,
        })
      )
    }

    return Ok({
      state: "ok",
      planVersion: val as PlanVersion,
    })
  }

  public async getPlanVersionFeatureByIdDetailed({
    id,
    projectId,
  }: {
    id: string
    projectId: string
  }): Promise<
    Result<
      | (PlanVersionFeature & {
          planVersion: PlanVersion
          feature: Feature
        })
      | null,
      FetchError
    >
  > {
    const { val, err } = await wrapResult(
      this.db.query.planVersionFeatures.findFirst({
        with: {
          planVersion: true,
          feature: true,
        },
        where: (planVersionFeature, { and, eq }) =>
          and(eq(planVersionFeature.id, id), eq(planVersionFeature.projectId, projectId)),
      }),
      (error) =>
        new FetchError({
          message: `error getting plan version feature by id: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error getting plan version feature by id",
        projectId,
        planVersionFeatureId: id,
      })
      return Err(err)
    }

    return Ok(
      (val as (PlanVersionFeature & { planVersion: PlanVersion; feature: Feature }) | null) ?? null
    )
  }

  public async listPlanVersionFeaturesByPlanVersionId({
    planVersionId,
    projectId,
  }: {
    planVersionId: string
    projectId: string
  }): Promise<
    Result<
      | { state: "plan_version_not_found" }
      | {
          state: "ok"
          planVersionFeatures: Array<
            PlanVersionFeature & {
              planVersion: Pick<PlanVersion, "id">
              feature: Feature
            }
          >
        },
      FetchError
    >
  > {
    const planVersionData = await this.db.query.versions.findFirst({
      where: (version, { and, eq }) =>
        and(eq(version.id, planVersionId), eq(version.projectId, projectId)),
    })

    if (!planVersionData?.id) {
      return Ok({ state: "plan_version_not_found" })
    }

    const { val, err } = await wrapResult(
      this.db.query.planVersionFeatures.findMany({
        with: {
          planVersion: {
            columns: {
              id: true,
            },
          },
          feature: true,
        },
        where: (planVersionFeature, { and, eq }) =>
          and(
            eq(planVersionFeature.planVersionId, planVersionId),
            eq(planVersionFeature.projectId, projectId)
          ),
      }),
      (error) =>
        new FetchError({
          message: `error listing plan version features by plan version id: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error listing plan version features by plan version id",
        projectId,
        planVersionId,
      })
      return Err(err)
    }

    return Ok({
      state: "ok",
      planVersionFeatures:
        (val as Array<
          PlanVersionFeature & {
            planVersion: Pick<PlanVersion, "id">
            feature: Feature
          }
        >) ?? [],
    })
  }

  public async createPlanVersionFeatureRecord({
    projectId,
    featureId,
    planVersionId,
    featureType,
    config,
    metadata,
    order,
    defaultQuantity,
    limit,
    billingConfig,
    resetConfig,
    type,
    unitOfMeasure,
    meterConfig,
    hasMeterConfigOverride,
  }: {
    projectId: string
    featureId: string
    planVersionId: string
    featureType: PlanVersionFeature["featureType"]
    config: PlanVersionFeature["config"]
    metadata?: PlanVersionFeature["metadata"]
    order?: PlanVersionFeature["order"]
    defaultQuantity?: PlanVersionFeature["defaultQuantity"]
    limit?: PlanVersionFeature["limit"]
    billingConfig: PlanVersionFeature["billingConfig"]
    resetConfig?: PlanVersionFeature["resetConfig"]
    type?: PlanVersionFeature["type"]
    unitOfMeasure?: PlanVersionFeature["unitOfMeasure"]
    meterConfig?: PlanVersionFeature["meterConfig"]
    hasMeterConfigOverride: boolean
  }): Promise<
    Result<
      | {
          state:
            | "plan_version_not_found"
            | "plan_version_published"
            | "feature_not_found"
            | "usage_meter_config_required"
            | "invalid_reset_config"
        }
      | {
          state: "ok"
          planVersionFeature: PlanVersionFeature & {
            planVersion: PlanVersion
            feature: Feature
          }
        },
      FetchError
    >
  > {
    const planVersionData = await this.db.query.versions.findFirst({
      where: (version, { eq, and }) =>
        and(eq(version.id, planVersionId), eq(version.projectId, projectId)),
    })

    if (!planVersionData?.id) {
      return Ok({
        state: "plan_version_not_found",
      })
    }

    if (planVersionData.status === "published") {
      return Ok({
        state: "plan_version_published",
      })
    }

    const featureData = await this.db.query.features.findFirst({
      where: (feature, { eq, and }) =>
        and(eq(feature.id, featureId), eq(feature.projectId, projectId)),
    })

    if (!featureData?.id) {
      return Ok({
        state: "feature_not_found",
      })
    }

    const planVersionFeatureId = newId("feature_version")

    const billingConfigCreate =
      featureType === "usage" ? billingConfig : planVersionData.billingConfig

    const meterConfigSnapshot =
      featureType !== "usage"
        ? null
        : hasMeterConfigOverride
          ? (meterConfig ?? null)
          : (featureData.meterConfig ?? null)

    if (featureType === "usage" && !meterConfigSnapshot) {
      return Ok({
        state: "usage_meter_config_required",
      })
    }

    const resetConfigCreate = billingConfigCreate.name === resetConfig?.name ? null : resetConfig

    if (resetConfigCreate) {
      try {
        getAnchor(Date.now(), resetConfigCreate.resetInterval, resetConfigCreate.resetAnchor)
      } catch {
        return Ok({
          state: "invalid_reset_config",
        })
      }
    }

    const { val, err } = await wrapResult(
      this.db.transaction(async (tx) => {
        const planVersionFeatureCreated = await tx
          .insert(schema.planVersionFeatures)
          .values({
            id: planVersionFeatureId,
            featureId: featureData.id,
            projectId,
            planVersionId: planVersionData.id,
            unitOfMeasure: unitOfMeasure ?? featureData.unitOfMeasure ?? "units",
            billingConfig: {
              ...billingConfigCreate,
              billingAnchor: planVersionData.billingConfig.billingAnchor,
            },
            featureType,
            config,
            metadata,
            order: Number(order ?? 1024),
            defaultQuantity: defaultQuantity === 0 ? null : defaultQuantity,
            limit: limit === 0 ? null : limit,
            resetConfig: resetConfigCreate,
            type: type ?? "feature",
            meterConfig: meterConfigSnapshot,
          })
          .returning()
          .then((rows) => rows[0] ?? null)

        if (!planVersionFeatureCreated?.id) {
          return null
        }

        return tx.query.planVersionFeatures.findFirst({
          with: {
            planVersion: true,
            feature: true,
          },
          where: (planVersionFeature, { and, eq }) =>
            and(
              eq(planVersionFeature.id, planVersionFeatureCreated.id),
              eq(planVersionFeature.projectId, projectId)
            ),
        })
      }),
      (error) =>
        new FetchError({
          message: `error creating plan version feature: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error creating plan version feature",
        projectId,
        planVersionId,
        featureId,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "Error creating feature for this version",
          retry: false,
        })
      )
    }

    return Ok({
      state: "ok",
      planVersionFeature: val as PlanVersionFeature & {
        planVersion: PlanVersion
        feature: Feature
      },
    })
  }

  public async updatePlanVersionFeatureRecord({
    projectId,
    id,
    planVersionId,
    featureId,
    featureType,
    config,
    metadata,
    order,
    defaultQuantity,
    limit,
    billingConfig,
    resetConfig,
    type,
    unitOfMeasure,
    meterConfig,
    hasMeterConfigOverride,
  }: {
    projectId: string
    id: string
    planVersionId: string
    featureId?: PlanVersionFeature["featureId"]
    featureType?: PlanVersionFeature["featureType"]
    config?: PlanVersionFeature["config"]
    metadata?: PlanVersionFeature["metadata"]
    order?: PlanVersionFeature["order"]
    defaultQuantity?: PlanVersionFeature["defaultQuantity"]
    limit?: PlanVersionFeature["limit"]
    billingConfig?: PlanVersionFeature["billingConfig"]
    resetConfig?: PlanVersionFeature["resetConfig"]
    type?: PlanVersionFeature["type"]
    unitOfMeasure?: PlanVersionFeature["unitOfMeasure"]
    meterConfig?: PlanVersionFeature["meterConfig"]
    hasMeterConfigOverride: boolean
  }): Promise<
    Result<
      | {
          state:
            | "plan_version_feature_not_found"
            | "plan_version_not_found"
            | "plan_version_published"
            | "usage_meter_config_required"
            | "invalid_reset_config"
        }
      | {
          state: "ok"
          planVersionFeature: PlanVersionFeature & {
            planVersion: PlanVersion
            feature: Feature
          }
        },
      FetchError
    >
  > {
    const existingPlanVersionFeature = await this.db.query.planVersionFeatures.findFirst({
      with: {
        feature: true,
      },
      where: (planVersionFeature, { and, eq }) =>
        and(eq(planVersionFeature.id, id), eq(planVersionFeature.projectId, projectId)),
    })

    if (!existingPlanVersionFeature?.id) {
      return Ok({
        state: "plan_version_feature_not_found",
      })
    }

    const planVersionData = await this.db.query.versions.findFirst({
      where: (version, { and, eq }) =>
        and(eq(version.id, planVersionId), eq(version.projectId, projectId)),
    })

    if (!planVersionData?.id) {
      return Ok({
        state: "plan_version_not_found",
      })
    }

    if (planVersionData.status === "published") {
      return Ok({
        state: "plan_version_published",
      })
    }

    const featureTypeUpdate = featureType ?? existingPlanVersionFeature.featureType
    const billingConfigUpdate =
      featureTypeUpdate === "usage" ? billingConfig : planVersionData.billingConfig

    const featureData = existingPlanVersionFeature.feature
    const unitOfMeasureUpdate =
      unitOfMeasure ?? existingPlanVersionFeature.feature.unitOfMeasure ?? "units"

    const shouldUpdateMeterConfig =
      hasMeterConfigOverride || featureId !== undefined || featureType !== undefined

    const meterConfigUpdate =
      featureTypeUpdate !== "usage"
        ? null
        : hasMeterConfigOverride
          ? (meterConfig ?? null)
          : featureData !== undefined
            ? (featureData.meterConfig ?? null)
            : (existingPlanVersionFeature.meterConfig ?? null)

    if (featureTypeUpdate === "usage" && shouldUpdateMeterConfig && !meterConfigUpdate) {
      return Ok({
        state: "usage_meter_config_required",
      })
    }

    if (resetConfig) {
      try {
        getAnchor(Date.now(), resetConfig.resetInterval, resetConfig.resetAnchor)
      } catch {
        return Ok({
          state: "invalid_reset_config",
        })
      }
    }

    const { val, err } = await wrapResult(
      this.db.transaction(async (tx) => {
        const planVersionFeatureUpdated = await tx
          .update(schema.planVersionFeatures)
          .set({
            ...(planVersionId && { planVersionId }),
            ...(featureId && { featureId }),
            ...(featureType && { featureType }),
            ...(config && { config }),
            ...(metadata && { metadata: { ...planVersionData.metadata, ...metadata } }),
            ...(order && { order }),
            ...(unitOfMeasureUpdate !== undefined && { unitOfMeasure: unitOfMeasureUpdate }),
            ...(defaultQuantity !== undefined && {
              defaultQuantity: defaultQuantity === 0 ? null : defaultQuantity,
            }),
            ...(limit !== undefined && { limit: limit === 0 ? null : limit }),
            ...(shouldUpdateMeterConfig && {
              meterConfig: meterConfigUpdate,
            }),
            ...(billingConfigUpdate && {
              billingConfig: {
                ...billingConfigUpdate,
                billingAnchor: planVersionData.billingConfig.billingAnchor,
              },
            }),
            ...(resetConfig && { resetConfig }),
            ...(type && { type }),
            updatedAtM: Date.now(),
          })
          .where(
            and(
              eq(schema.planVersionFeatures.id, id),
              eq(schema.planVersionFeatures.projectId, projectId)
            )
          )
          .returning()
          .then((rows) => rows[0] ?? null)

        if (!planVersionFeatureUpdated?.id) {
          return null
        }

        return tx.query.planVersionFeatures.findFirst({
          with: {
            planVersion: true,
            feature: true,
          },
          where: (planVersionFeature, { and, eq }) =>
            and(
              eq(planVersionFeature.id, planVersionFeatureUpdated.id),
              eq(planVersionFeature.projectId, projectId)
            ),
        })
      }),
      (error) =>
        new FetchError({
          message: `error updating plan version feature: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error updating plan version feature",
        projectId,
        planVersionFeatureId: id,
        planVersionId,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "Error updating version feature",
          retry: false,
        })
      )
    }

    return Ok({
      state: "ok",
      planVersionFeature: val as PlanVersionFeature & {
        planVersion: PlanVersion
        feature: Feature
      },
    })
  }

  public async removePlanVersionFeatureRecord({
    projectId,
    id,
  }: {
    projectId: string
    id: string
  }): Promise<
    Result<
      | { state: "not_found" | "published_conflict" }
      | {
          state: "ok"
          planVersionFeature: PlanVersionFeature
        },
      FetchError
    >
  > {
    const planVersionFeatureData = await this.db.query.planVersionFeatures.findFirst({
      with: {
        planVersion: true,
      },
      where: (featureVersion, { and, eq }) =>
        and(eq(featureVersion.id, id), eq(featureVersion.projectId, projectId)),
    })

    if (!planVersionFeatureData?.id) {
      return Ok({
        state: "not_found",
      })
    }

    if (planVersionFeatureData.planVersion.status === "published") {
      return Ok({
        state: "published_conflict",
      })
    }

    const { val, err } = await wrapResult(
      this.db
        .delete(schema.planVersionFeatures)
        .where(
          and(
            eq(schema.planVersionFeatures.projectId, projectId),
            eq(schema.planVersionFeatures.id, id)
          )
        )
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error removing plan version feature: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error removing plan version feature",
        projectId,
        planVersionFeatureId: id,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "Error deleting feature",
          retry: false,
        })
      )
    }

    return Ok({
      state: "ok",
      planVersionFeature: val as PlanVersionFeature,
    })
  }
}
