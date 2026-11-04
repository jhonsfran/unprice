import { NoopTinybird, Tinybird } from "@jhonsfran/zod-bird"
import { z } from "zod"
import {
  type AnalyticsEventAction,
  analyticsEventSchema,
  billingPeriodUsageCoverageRowSchema,
  billingPeriodUsageRowSchema,
  entitlementMeterFactSchemaV1,
  explainChargeEventRowSchema,
  explainChargeQuerySchema,
  explainChargeSummaryQuerySchema,
  explainChargeSummaryRowSchema,
  featureUsagePeriodRowSchema,
  featureUsageTimeseriesRowSchema,
  ingestionEventSchemaV1,
  ingestionFacetRowSchema,
  ingestionFacetsQuerySchema,
  ingestionLiveQuerySchema,
  ingestionLiveRowSchema,
  ingestionRecentEventRowSchema,
  ingestionRecentQuerySchema,
  ingestionRejectionRowSchema,
  ingestionRejectionsQuerySchema,
  ingestionReplayPayloadQuerySchema,
  ingestionReplayPayloadRowSchema,
  pageEventSchema,
  schemaPlanClick,
  topConsumerRowSchema,
} from "./validators"

export class Analytics {
  public readonly readClient: Tinybird | NoopTinybird
  public readonly writeClient: Tinybird | NoopTinybird
  public readonly isNoop: boolean

  constructor(opts: {
    emit: boolean
    tinybirdToken?: string
    tinybirdUrl: string
    tinybirdProxy?: {
      url: string
      token: string
    }
  }) {
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

  public get ingestIngestionEvents() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_ingestion_events",
      event: ingestionEventSchemaV1,
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
        project_id: z.string(),
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
        ...featureUsagePeriodRowSchema.shape,
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  /**
   * Billed metered deltas grouped by the subscription billing period that
   * accepted the event. This intentionally does not expose enforcement state:
   * use access.check for a real-time quota decision.
   */
  public get getBillingPeriodUsage() {
    return this.readClient.buildPipe({
      pipe: "v1_get_billing_period_usage",
      parameters: z.object({
        project_id: z.string(),
        customer_id: z.string(),
        billing_period_ids: z.array(z.string()).min(1),
        start: z.number().int(),
        end: z.number().int(),
      }),
      data: billingPeriodUsageRowSchema,
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  /**
   * Counts facts in a billing-period report envelope that predate
   * billing-period attribution. Callers must not present a partial report.
   */
  public get getBillingPeriodUsageCoverage() {
    return this.readClient.buildPipe({
      pipe: "v1_get_billing_period_usage_coverage",
      parameters: z.object({
        project_id: z.string(),
        customer_id: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      }),
      data: billingPeriodUsageCoverageRowSchema,
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  public get getFeaturesUsageTimeseries() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_usage_timeseries",
      parameters: z
        .object({
          project_id: z.string(),
          customer_id: z.string().optional(),
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
        ...featureUsageTimeseriesRowSchema.shape,
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000,
      },
    })
  }

  public get getTopConsumers() {
    return this.readClient.buildPipe({
      pipe: "v1_get_top_consumers",
      parameters: z
        .object({
          project_id: z.string(),
          interval_days: z.number().optional(),
          start: z.number().optional(),
          end: z.number().optional(),
          limit: z.number().optional(),
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
        ...topConsumerRowSchema.shape,
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000,
      },
    })
  }

  public get getExplainChargeEvents() {
    return this.readClient.buildPipe({
      pipe: "v1_explain_charge_events",
      parameters: explainChargeQuerySchema,
      data: explainChargeEventRowSchema,
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000,
      },
    })
  }

  public get getExplainChargeSummary() {
    return this.readClient.buildPipe({
      pipe: "v1_explain_charge_summary",
      parameters: explainChargeSummaryQuerySchema,
      data: explainChargeSummaryRowSchema,
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000,
      },
    })
  }

  public get getIngestionLive() {
    return this.readClient.buildPipe({
      pipe: "v1_get_ingestion_live",
      parameters: ingestionLiveQuerySchema,
      data: ingestionLiveRowSchema,
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000,
      },
    })
  }

  public get getIngestionRejections() {
    return this.readClient.buildPipe({
      pipe: "v1_get_ingestion_rejections",
      parameters: ingestionRejectionsQuerySchema,
      data: ingestionRejectionRowSchema,
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000,
      },
    })
  }

  public get getIngestionRecent() {
    return this.readClient.buildPipe({
      pipe: "v1_get_ingestion_recent",
      parameters: ingestionRecentQuerySchema,
      data: ingestionRecentEventRowSchema,
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000,
      },
    })
  }

  public get getIngestionFacets() {
    return this.readClient.buildPipe({
      pipe: "v1_get_ingestion_facets",
      parameters: ingestionFacetsQuerySchema,
      data: ingestionFacetRowSchema,
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000,
      },
    })
  }

  public get getIngestionReplayPayloads() {
    return this.readClient.buildPipe({
      pipe: "v1_get_ingestion_replay_payloads",
      parameters: ingestionReplayPayloadQuerySchema,
      data: ingestionReplayPayloadRowSchema,
      opts: {
        cache: "no-store",
        retries: 2,
        timeout: 5000,
      },
    })
  }
}
