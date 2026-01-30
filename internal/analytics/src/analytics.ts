import { NoopTinybird, Tinybird } from "@jhonsfran/zod-bird"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { z } from "zod"
import { UnPriceAnalyticsError } from "./errors"
import {
  type AnalyticsEventAction,
  analyticsEventSchema,
  auditLogSchemaV1,
  featureUsageSchemaV1,
  featureVerificationSchemaV1,
  pageEventSchema,
  schemaFeature,
  schemaPlanClick,
  schemaPlanVersion,
  schemaPlanVersionFeature,
} from "./validators"

// TODO: create interface to handle multiple clients analytics
export class Analytics {
  public readonly readClient: Tinybird | NoopTinybird
  public readonly writeClient: Tinybird | NoopTinybird
  public readonly isNoop: boolean
  private readonly logger: Logger

  constructor(opts: {
    logger: Logger
    emit: boolean
    tinybirdToken?: string
    tinybirdUrl: string
    tinybirdProxy?: {
      url: string
      token: string
    }
  }) {
    this.logger = opts.logger
    this.readClient =
      opts.tinybirdToken && opts.emit
        ? new Tinybird({ token: opts.tinybirdToken, baseUrl: opts.tinybirdUrl })
        : new NoopTinybird()

    // TODO: implement delete endpoint https://www.tinybird.co/docs/api-reference/datasource-api#delete--v0-datasources-(.+)
    this.writeClient =
      opts.tinybirdProxy && opts.emit
        ? new Tinybird({
            token: opts.tinybirdProxy.token,
            baseUrl: opts.tinybirdProxy.url,
          })
        : this.readClient

    this.isNoop = this.writeClient instanceof NoopTinybird
  }

  public get ingestSdkTelemetry() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "sdk_telemetry",
      event: z.object({
        runtime: z.string(),
        platform: z.string(),
        versions: z.array(z.string()),
        requestId: z.string(),
        time: z.number(),
      }),
    })
  }

  public get ingestGenericAuditLogs() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "audit_logs__v2",
      event: auditLogSchemaV1.transform((l) => ({
        ...l,
        meta: l.meta ? JSON.stringify(l.meta) : undefined,
        actor: {
          ...l.actor,
          meta: l.actor.meta ? JSON.stringify(l.actor.meta) : undefined,
        },
        resources: JSON.stringify(l.resources),
      })),
    })
  }

  public get ingestFeaturesVerification() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_feature_verifications",
      event: featureVerificationSchemaV1,
      // we need to wait for the ingestion to be done before returning
      wait: true,
    })
  }

  public get ingestFeaturesUsage() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_feature_usage_records",
      event: featureUsageSchemaV1,
      // we need to wait for the ingestion to be done before returning
      wait: true,
    })
  }

  public get ingestEvents() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_events",
      event: analyticsEventSchema,
      // we need to wait for the ingestion to be done before returning
      wait: true,
    })
  }

  public get ingestFeatures() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_features",
      event: schemaFeature,
    })
  }

  public get ingestPlanVersionFeatures() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_plan_version_features",
      event: schemaPlanVersionFeature,
    })
  }

  public get ingestPageEvents() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_page_hits",
      event: pageEventSchema,
    })
  }

  public get ingestPlanVersions() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_plan_versions",
      event: schemaPlanVersion,
    })
  }

  // analytics pages
  public get getPlanClickBySessionId() {
    return this.readClient.buildPipe({
      pipe: "v1_get_session_event",
      parameters: z.object({
        session_id: z.string(),
        action: z.literal("plan_click"),
        interval_days: z.number().optional(),
      }),
      data: z.object({
        timestamp: z.coerce.date(),
        session_id: z.string(),
        payload: z.string().transform((payload) => schemaPlanClick.parse(JSON.parse(payload))),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics events
  public get getLatestEvents() {
    return this.readClient.buildPipe({
      pipe: "v1_get_latest_events",
      parameters: z.object({
        action: z.custom<AnalyticsEventAction>().optional(),
        project_id: z.string().optional(),
        interval_days: z.number().optional(),
      }),
      data: z.object({
        timestamp: z.coerce.date(),
        action: z.string(),
        session_id: z.string(),
        payload: z.string(),
      }),
    })
  }

  // analytics pages
  public get getPlansConversion() {
    return this.readClient.buildPipe({
      pipe: "v1_get_plans_conversion",
      parameters: z.object({
        intervalDays: z.number().optional(),
        projectId: z.string().optional(),
      }),
      data: z.object({
        page_id: z.string(),
        plan_version_id: z.string(),
        plan_views: z.number(),
        plan_clicks: z.number(),
        plan_signups: z.number(),
        conversion: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics pages
  public get getBrowserVisits() {
    return this.readClient.buildPipe({
      pipe: "v1_get_top_browsers",
      parameters: z.object({
        intervalDays: z.number().optional(),
        page_id: z.string().optional(),
        project_id: z.string().optional(),
      }),
      data: z.object({
        page_id: z.string(),
        browser: z.string(),
        visits: z.number(),
        hits: z.number(),
      }),
      opts: {
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics pages
  public get getCountryVisits() {
    return this.readClient.buildPipe({
      pipe: "v1_get_top_countries",
      parameters: z.object({
        intervalDays: z.number().optional(),
        page_id: z.string().optional(),
        project_id: z.string().optional(),
      }),
      data: z.object({
        page_id: z.string(),
        country: z.string(),
        visits: z.number(),
        hits: z.number(),
      }),
      opts: {
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  public get getPagesOverview() {
    return this.readClient.buildPipe({
      pipe: "v1_get_pages_overview",
      parameters: z.object({
        intervalDays: z.number().optional(),
        pageId: z.string().optional(),
        projectId: z.string().optional(),
      }),
      data: z.object({
        date: z.coerce.date(),
        page_id: z.string(),
        desktop_visits: z.number(),
        mobile_visits: z.number(),
        other_visits: z.number(),
        desktop_hits: z.number(),
        mobile_hits: z.number(),
        other_hits: z.number(),
        total_visits: z.number(),
        total_hits: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics features
  public get getFeaturesOverview() {
    return this.readClient.buildPipe({
      pipe: "v1_get_features_overview",
      parameters: z.object({
        intervalDays: z.number().optional(),
        projectId: z.string().optional(),
        timezone: z.string().optional(),
      }),
      data: z.object({
        date: z.coerce.date(),
        latency: z.number(),
        verifications: z.number(),
        usage: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  public get getFeaturesVerifications() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_verifications",
      parameters: z.object({
        projectId: z.string().optional(),
        customerId: z.string().optional(),
        featureSlugs: z.array(z.string()).optional(),
        intervalDays: z.number().optional(),
      }),
      data: z.object({
        projectId: z.string(),
        customerId: z.string().optional(),
        featureSlug: z.string(),
        count: z.number(),
        p50_latency: z.number(),
        p95_latency: z.number(),
        p99_latency: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics verifications
  public get getFeaturesVerificationRegions() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_verification_regions",
      parameters: z.object({
        intervalDays: z.number().optional(),
        projectId: z.string(),
        timezone: z.string().optional(),
        region: z.string().optional(),
        start: z.number().optional(),
        end: z.number().optional(),
      }),
      data: z.object({
        date: z.coerce.date(),
        region: z.string(),
        count: z.number(),
        p50_latency: z.number(),
        p95_latency: z.number(),
        p99_latency: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics usage
  public get getFeaturesUsagePeriod() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_usage_period",
      parameters: z.object({
        projectId: z.string(),
        customerId: z.string().optional(),
        featureSlugs: z.array(z.string()).optional(),
        intervalDays: z.number().optional(),
        start: z.number().optional(),
        end: z.number().optional(),
      }),
      data: z.object({
        projectId: z.string(),
        customerId: z.string().optional(),
        featureSlug: z.string(),
        count: z.number(),
        sum: z.number(),
        max: z.number(),
        last_during_period: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics usage
  public get getFeaturesUsage() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_usage_cursor",
      parameters: z.object({
        projectId: z.string(),
        customerId: z.string(),
        featureSlug: z.string(),
        afterRecordId: z.string(),
        beforeRecordId: z.string().optional(),
        billingPeriodStart: z.number().optional(),
      }),
      data: z.object({
        featureSlug: z.string(),
        projectId: z.string(),
        customerId: z.string(),
        deltaCount: z.number(),
        deltaSum: z.number(),
        deltaMax: z.number(),
        lastValue: z.number(),
        lastRecordId: z.string(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  public get getBillingUsage() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_usage_no_duplicates",
      parameters: z.object({
        featureSlugs: z.array(z.string()).optional(),
        customerId: z.string(),
        projectId: z.string(),
        start: z.number(),
        end: z.number(),
      }),
      data: z.object({
        projectId: z.string(),
        customerId: z.string(),
        featureSlug: z.string(),
        sum: z.number(),
        max: z.number(),
        count: z.number(),
        last_during_period: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  public get getFeatureHeatmap() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_heatmap",
      parameters: z.object({
        projectId: z.string().optional(),
        start: z.number().optional(),
        end: z.number().optional(),
        intervalDays: z.number().optional(),
      }),
      data: z.object({
        plan_slug: z.string(),
        feature_slug: z.string(),
        project_id: z.string(),
        usage_count: z.number(),
        usage_sum: z.number(),
        verification_count: z.number(),
        activity_score: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // TODO: add telemtry for this endpoint to know how many times it's being called and the latency
  public async getUsageBillingFeatures({
    customerId,
    projectId,
    features,
    startAt,
    endAt,
  }: {
    customerId: string
    projectId: string
    features: {
      featureSlug: string
      aggregationMethod:
        | "none"
        | "sum"
        | "count"
        | "max"
        | "last"
        | "sum_all"
        | "max_all"
        | "count_all"
        | "last_during_period"
      featureType: "usage" | "package" | "tier" | "flat"
    }[]
    startAt: number
    endAt: number
  }): Promise<
    Result<{ featureSlug: string; usage: number }[], FetchError | UnPriceAnalyticsError>
  > {
    const AGGREGATION_CONFIG: Record<
      "none" | "sum" | "max" | "count" | "sum_all" | "max_all" | "count_all" | "last_during_period",
      { behavior: "none" | "sum" | "max" | "last"; scope: "period" | "lifetime" }
    > = {
      // Period Scoped (Resets on Cycle)
      none: { behavior: "none", scope: "period" },
      sum: { behavior: "sum", scope: "period" },
      count: { behavior: "sum", scope: "period" }, // count is just sum(+1)
      max: { behavior: "max", scope: "period" },
      last_during_period: { behavior: "last", scope: "period" },

      // Lifetime Scoped (Never Resets)
      sum_all: { behavior: "sum", scope: "lifetime" },
      count_all: { behavior: "sum", scope: "lifetime" },
      max_all: { behavior: "max", scope: "lifetime" },
    }
    // filter that only usage, package and tier features are being requested
    const featuresUsage = features.filter((feature) =>
      ["usage", "package", "tier"].includes(feature.featureType)
    )

    const featureSlugsArray = featuresUsage.map((feature) => feature.featureSlug)

    if (featureSlugsArray.length === 0) {
      return Ok([])
    }

    // we use the same endpoint for billing usage as it's the
    // more accurate one because it's using FINAL in ClickHouse queries
    // to merge data parts at query time to resolve updates and deletions
    const totalPeriodUsages = await this.getBillingUsage({
      customerId,
      projectId,
      featureSlugs: featureSlugsArray,
      start: startAt,
      end: endAt,
    })
      .then((usage) => usage.data ?? [])
      .catch((error) => {
        console.error(error)
        this.logger.error(`Error getBillingUsage:${error.message}`, {
          customerId,
          projectId,
          featureSlugs: featureSlugsArray,
          startAt,
          endAt,
        })
        return null
      })

    // if there was an error, return null
    if (totalPeriodUsages === null) {
      return Err(
        new UnPriceAnalyticsError({ message: "Error getting usage billing subscription items" })
      )
    }

    // if there are no usages, return an empty array
    if (totalPeriodUsages.length === 0) {
      return Ok([])
    }

    const result = []

    // iterate over the features
    for (const feature of featuresUsage) {
      const totalPeriodUsage = totalPeriodUsages.find(
        (usage) => usage.featureSlug === feature.featureSlug
      )

      if (!totalPeriodUsage) {
        this.logger.error("No usage found for feature", {
          featureSlug: feature.featureSlug,
          customerId,
          projectId,
        })
        continue
      }

      // get the aggregation config for the feature
      const config =
        AGGREGATION_CONFIG[feature.aggregationMethod as keyof typeof AGGREGATION_CONFIG]

      if (!config) {
        this.logger.error("Invalid aggregation method", {
          aggregationMethod: feature.aggregationMethod,
          featureSlug: feature.featureSlug,
          customerId,
          projectId,
        })

        continue
      }

      let usage = 0

      if (config.behavior === "sum") {
        if (feature.aggregationMethod === "count") {
          usage = totalPeriodUsage.count ?? 0
        } else {
          usage = totalPeriodUsage.sum ?? 0
        }
      } else if (config.behavior === "max") {
        usage = totalPeriodUsage.max ?? 0
      } else if (config.behavior === "last") {
        usage = totalPeriodUsage.last_during_period ?? 0
      }

      result.push({
        featureSlug: feature.featureSlug,
        usage: usage,
      })
    }

    return Ok(result)
  }

  /* cursor based usage for reconciliation */
  public async getFeaturesUsageCursor({
    customerId,
    projectId,
    feature,
    afterRecordId,
    beforeRecordId,
    startAt,
  }: {
    customerId: string
    projectId: string
    feature: {
      featureSlug: string
      aggregationMethod:
        | "none"
        | "sum"
        | "count"
        | "max"
        | "last"
        | "sum_all"
        | "max_all"
        | "count_all"
        | "last_during_period"
      featureType: "usage" | "package" | "tier" | "flat"
    }
    afterRecordId: string
    beforeRecordId: string
    startAt: number
  }): Promise<
    Result<
      {
        featureSlug: string
        usage: number
        lastRecordId: string
      },
      FetchError | UnPriceAnalyticsError
    >
  > {
    const AGGREGATION_CONFIG: Record<
      "none" | "sum" | "max" | "count" | "sum_all" | "max_all" | "count_all" | "last_during_period",
      { behavior: "none" | "sum" | "max" | "last"; scope: "period" | "lifetime" }
    > = {
      // Period Scoped (Resets on Cycle)
      none: { behavior: "none", scope: "period" },
      sum: { behavior: "sum", scope: "period" },
      count: { behavior: "sum", scope: "period" }, // count is just sum(+1)
      max: { behavior: "max", scope: "period" },
      last_during_period: { behavior: "last", scope: "period" },

      // Lifetime Scoped (Never Resets)
      sum_all: { behavior: "sum", scope: "lifetime" },
      count_all: { behavior: "sum", scope: "lifetime" },
      max_all: { behavior: "max", scope: "lifetime" },
    }

    // filter that only usage, package and tier features are being requested
    if (!["usage", "package", "tier"].includes(feature.featureType)) {
      return Ok({
        featureSlug: feature.featureSlug,
        usage: 0,
        lastRecordId: "",
      })
    }

    const config = AGGREGATION_CONFIG[feature.aggregationMethod as keyof typeof AGGREGATION_CONFIG]

    if (!config) {
      return Err(new UnPriceAnalyticsError({ message: "Invalid aggregation method" }))
    }

    let usage = 0

    // we use the same endpoint for billing usage as it's the
    // more accurate one
    // TODO: need to improve this for long range dates
    // and idea could be tiered mv for the different periods
    const result = await this.getFeaturesUsage({
      customerId,
      projectId,
      featureSlug: feature.featureSlug,
      afterRecordId,
      beforeRecordId,
      billingPeriodStart: startAt,
    })
      .then((usage) => usage.data ?? [])
      .catch((error) => {
        this.logger.error("Error getting features usage cursor", {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: error instanceof Error ? error.name : undefined,
            stack: error instanceof Error ? error.stack : undefined,
          },
          customerId,
          projectId,
          featureSlug: feature.featureSlug,
          afterRecordId,
          beforeRecordId,
          startAt,
        })
        return null
      })

    if (result === null) {
      return Err(new UnPriceAnalyticsError({ message: "Error getting features usage cursor" }))
    }

    const delta = result?.[0]

    // if there are no usages, return an empty array
    if (!delta) {
      return Ok({
        featureSlug: feature.featureSlug,
        usage: 0,
        lastRecordId: "",
      })
    }

    if (config.behavior === "sum") {
      if (feature.aggregationMethod === "count") {
        usage = delta.deltaCount
      } else {
        usage = delta.deltaSum
      }
    } else if (config.behavior === "max") {
      usage = delta.deltaMax
    } else if (config.behavior === "last") {
      usage = delta.lastValue
    }

    return Ok({
      featureSlug: feature.featureSlug,
      usage,
      lastRecordId: delta.lastRecordId,
    })
  }
}
