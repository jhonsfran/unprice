import { NoopTinybird, Tinybird } from "@jhonsfran/zod-bird"
import { z } from "zod"
import {
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
