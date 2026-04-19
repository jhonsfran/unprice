import { NoopTinybird, Tinybird } from "@jhonsfran/zod-bird"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import { UnPriceAnalyticsError } from "./errors"
import {
  type AnalyticsEventAction,
  analyticsEventSchema,
  entitlementMeterFactSchemaV1,
  pageEventSchema,
  schemaPlanClick,
} from "./validators"

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

  public get ingestEntitlementMeterFacts() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_entitlement_meter_facts",
      event: entitlementMeterFactSchemaV1,
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

  public get ingestPageEvents() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_page_hits",
      event: pageEventSchema,
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

  public get getPlansConversion() {
    return this.readClient.buildPipe({
      pipe: "v1_get_plans_conversion",
      parameters: z.object({
        interval_days: z.number().optional(),
        project_id: z.string().optional(),
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
        timeout: 5000,
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
  public get getBrowserVisits() {
    return this.readClient.buildPipe({
      pipe: "v1_get_top_browsers",
      parameters: z.object({
        interval_days: z.number().optional(),
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
        cache: "no-store",
      },
    })
  }

  // analytics pages
  public get getCountryVisits() {
    return this.readClient.buildPipe({
      pipe: "v1_get_top_countries",
      parameters: z.object({
        interval_days: z.number().optional(),
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
        cache: "no-store",
      },
    })
  }

  public get getPagesOverview() {
    return this.readClient.buildPipe({
      pipe: "v1_get_pages_overview",
      parameters: z.object({
        interval_days: z.number().optional(),
        page_id: z.string().optional(),
        project_id: z.string().optional(),
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

  // analytics usage
  public get getFeaturesUsagePeriod() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_usage_period",
      parameters: z
        .object({
          project_id: z.string(),
          customer_id: z.string().optional(),
          period_key: z.string().optional(),
          interval_days: z.number().optional(),
          start: z.number().optional(),
          end: z.number().optional(),
          feature_slugs: z.array(z.string()).optional(),
        })
        .superRefine((params, ctx) => {
          const hasStart = typeof params.start !== "undefined"
          const hasEnd = typeof params.end !== "undefined"

          if (hasStart !== hasEnd) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "start and end must be provided together",
            })
          }
        }),
      data: z.object({
        project_id: z.string(),
        customer_id: z.string().optional(),
        feature_slug: z.string(),
        value_after: z.number(),
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
      pipe: "v1_get_feature_usage",
      parameters: z.object({
        project_id: z.string(),
        customer_id: z.string(),
        period_key: z.string(),
      }),
      data: z.object({
        project_id: z.string(),
        feature_slug: z.string(),
        customer_id: z.string(),
        value: z.string(),
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
        feature_slugs: z.array(z.string()).optional(),
        customer_id: z.string(),
        project_id: z.string(),
        start: z.number(),
        end: z.number(),
      }),
      data: z.object({
        project_id: z.string(),
        customer_id: z.string(),
        feature_slug: z.string(),
        latest: z.number(),
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
      aggregationMethod: "sum" | "count" | "max" | "latest"
      featureType: "usage" | "package" | "tier" | "flat"
    }[]
    startAt: number
    endAt: number
  }): Promise<
    Result<{ featureSlug: string; usage: number }[], FetchError | UnPriceAnalyticsError>
  > {
    const featuresUsage = features.filter((feature) => feature.featureType === "usage")

    const featureSlugsArray = featuresUsage.map((feature) => feature.featureSlug)

    if (featureSlugsArray.length === 0) {
      return Ok([])
    }

    const totalPeriodUsages = await this.getBillingUsage({
      customer_id: customerId,
      project_id: projectId,
      feature_slugs: featureSlugsArray,
      start: startAt,
      end: endAt,
    })
      .then((usage) => usage.data ?? [])
      .catch((error) => {
        this.logger.error(`Error getBillingUsage:${error.message}`, {
          customerId,
          projectId,
          feature_slugs: featureSlugsArray,
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
        (usage) => usage.feature_slug === feature.featureSlug
      )

      if (!totalPeriodUsage) {
        this.logger.error("No usage found for feature", {
          featureSlug: feature.featureSlug,
          customerId,
          projectId,
        })
        continue
      }

      result.push({
        featureSlug: feature.featureSlug,
        usage: totalPeriodUsage.latest ?? 0,
      })
    }

    return Ok(result)
  }

  /* cursor based usage for reconciliation */
  public async getFeaturesUsageCustomer({
    customerId,
    projectId,
    periodKey,
  }: {
    customerId: string
    projectId: string
    periodKey: string
  }): Promise<
    Result<
      {
        projectId: string
        customerId: string
        featureSlug: string
        value: string
      }[],
      FetchError | UnPriceAnalyticsError
    >
  > {
    const result = await this.getFeaturesUsage({
      customer_id: customerId,
      project_id: projectId,
      period_key: periodKey,
    }).catch((error) => {
      this.logger.error("Error getting features usage", {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: error instanceof Error ? error.name : undefined,
          stack: error instanceof Error ? error.stack : undefined,
        },
        customerId,
        projectId,
        periodKey,
      })
      return null
    })

    if (result?.data === null) {
      return Err(
        new UnPriceAnalyticsError({ message: "Error getting features usage for customer" })
      )
    }

    const data =
      result?.data.map((row) => ({
        featureSlug: row.feature_slug,
        customerId: row.customer_id,
        value: row.value,
        projectId: row.project_id,
      })) ?? []

    return Ok(data)
  }
}
