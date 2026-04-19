import { LEDGER_SCALE } from "@unprice/money"
import * as z from "zod"
import type { Analytics } from "./analytics"

export type MaybeArray<T> = T | T[]

/**
 * `t` has the format `2021-01-01 00:00:00`
 *
 * If we transform it as is, we get `1609459200000` which is `2021-01-01 01:00:00` due to fun timezone stuff.
 * So we split the string at the space and take the date part, and then parse that.
 */
export const dateToUnixMilli = z
  .string()
  .transform((t) => new Date(t.split(" ").at(0) ?? t).getTime())

export const datetimeToUnixMilli = z.string().transform((t) => new Date(t).getTime())

export const unixMilliToDate = z.number().transform((d) => {
  const date = new Date(d)
  // always use UTC
  date.setUTCHours(0, 0, 0, 0)
  return date.getTime()
})

export const jsonToNullableString = z.string().transform((s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
})

export const anyObject = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))

export const nullableJsonToString = anyObject.nullable().transform((s) => {
  if (s === null) return null
  try {
    return JSON.stringify(s)
  } catch {
    return null
  }
})

export const stringToUInt32 = z.union([z.string(), z.number()]).transform((s) => Number(s))
export const booleanToUInt8 = z.boolean().transform((b) => (b ? 1 : 0))

// We use a base schema for strong typing in the application
const baseMetadataSchema = z
  .object({
    // Analytics fields
    cost: z.string().optional().describe("incremental cost for this event"),
    rate: z.string().optional(),
    rate_amount: z.string().optional(),
    rate_currency: z.string().optional(),
    rate_unit_size: z.string().optional(),
    usage: z.string().optional().describe("amount of usage requested (verifications)"),
    remaining: z.string().optional().describe("remaining balance at verification"),
  })
  .catchall(z.union([z.string(), z.number(), z.boolean(), z.null()]))

export const metadataSchema = baseMetadataSchema.nullable().transform((m) => {
  if (!m) return null

  // Tinybird receives Map(String, String) - convert keys to snake_case if they aren't already
  // and ensure all values are strings
  const transformed = Object.fromEntries(
    Object.entries(m).map(([key, value]) => {
      // Convert camelCase to snake_case (e.g., "rate_amount" -> "rate_amount")
      const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase()

      // Convert all values to strings
      return [snakeKey, value?.toString() ?? ""]
    })
  )

  return transformed
})

// Convert bigint/string to number for UInt64 fields
// Note: loses precision for values > Number.MAX_SAFE_INTEGER, but acceptable for hash IDs
export const bigintToNumber = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((v) => Number(v))

export const featureVerificationSchemaV1 = z.object({
  project_id: z.string(),
  denied_reason: z.string().optional(),
  allowed: z.number().int().min(0).max(1).default(0),
  timestamp: z
    .number()
    .default(Date.now())
    .describe("timestamp of when this usage record should be billed"),
  created_at: z
    .number()
    .default(Date.now())
    .describe("timestamp of when this usage record was created"),
  latency: z.number().optional(),
  feature_slug: z.string(),
  customer_id: z.string(),
  request_id: z.string(),
  region: z.string().default("UNK"),
  meta_id: bigintToNumber.default(0),
  usage: z.number().optional(),
  remaining: z.number().optional(),
  entitlement_id: z.string(),
  // metadata is kept for internal SQLite storage, stripped before sending to Tinybird
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  // first-class analytics columns
  country: z.string().default("UNK"),
  action: z
    .string()
    .optional()
    .describe(
      "Action being performed (e.g. 'read', 'write', 'create', 'update', 'delete', 'list'). Use consistent values for filtering in analytics."
    ),
  key_id: z.string().optional(),
})

export const featureUsageSchemaV1 = z.object({
  id: z.string(),
  idempotence_key: z.string(),
  feature_slug: z.string(),
  request_id: z.string(),
  project_id: z.string(),
  customer_id: z.string(),
  timestamp: z.number().describe("timestamp of when this usage record should be billed"),
  usage: stringToUInt32,
  created_at: z.number().describe("timestamp of when this usage record was created"),
  deleted: z.number().int().min(0).max(1).default(0),
  meta_id: bigintToNumber.default(0),
  cost: z.number().optional(),
  rate_amount: z.number().optional(),
  rate_currency: z.string().optional(),
  entitlement_id: z.string(),
  // metadata is kept for internal SQLite storage, stripped before sending to Tinybird
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  // first-class analytics columns
  country: z.string().default("UNK"),
  region: z.string().default("UNK"),
  action: z
    .string()
    .optional()
    .describe(
      "Action being performed (e.g. 'read', 'write', 'create', 'update', 'delete', 'list'). Use consistent values for filtering in analytics."
    ),
  key_id: z.string().optional(),
})

export const featureMetadataSchemaV1 = z.object({
  meta_id: bigintToNumber,
  project_id: z.string(),
  customer_id: z.string(),
  timestamp: z.number(),
  tags: z.string(),
})

export const entitlementMeterFactSchemaV1 = z.object({
  id: z.string(),
  event_id: z.string(),
  idempotency_key: z.string(),
  project_id: z.string(),
  customer_id: z.string(),
  stream_id: z.string(),
  feature_slug: z.string(),
  period_key: z.string(),
  event_slug: z.string(),
  aggregation_method: z.string(),
  timestamp: z.number().describe("timestamp of the ingested event"),
  created_at: z.number().describe("timestamp of when the fact row was created"),
  delta: z.number(),
  value_after: z.number(),
  feature_plan_version_id: z.string().nullable().optional(),
  amount: z.number().int(),
  amount_scale: z.literal(LEDGER_SCALE),
  currency: z.string().length(3),
  priced_at: z.number().int(),
})

export const auditLogSchemaV1 = z.object({
  workspace_id: z.string(),
  audit_log_id: z.string(),
  event: z.string(),
  description: z.string().optional(),
  time: z.number(),
  meta: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  actor: z.object({
    type: z.string(),
    id: z.string(),
    name: z.string().optional(),
    meta: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  }),
  resources: z.array(
    z.object({
      type: z.string(),
      id: z.string(),
      name: z.string().optional(),
      meta: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    })
  ),
  context: z.object({
    location: z.string(),
    user_agent: z.string().optional(),
  }),
})

export const getAnalyticsVerificationsResponseSchema = z.object({
  project_id: z.string(),
  customer_id: z.string().optional(),
  feature_slug: z.string(),
  count: z.number(),
  p50_latency: z.number(),
  p95_latency: z.number(),
  p99_latency: z.number(),
})

export const getUsageResponseSchema = z.object({
  project_id: z.string(),
  customer_id: z.string().optional(),
  feature_slug: z.string(),
  value_after: z.number(),
})

export const schemaPageHit = z.object({
  page_id: z.string(),
  plan_ids: z.string().optional(),
  locale: z.string(),
  referrer: z.string(),
  pathname: z.string(),
  url: z.string(),
})

export const schemaPlanClick = z.object({
  plan_version_id: z.string(),
  page_id: z.string(),
})

export const schemaSignUp = z.object({
  customer_id: z.string(),
  plan_version_id: z.string(),
  page_id: z.string().nullable(),
  status: z.enum(["waiting_payment_provider_setup", "signup_failed", "signup_success"]),
})

export const analyticsEventBaseSchema = z.object({
  timestamp: z.string().datetime(),
  session_id: z.string(),
  project_id: z.string(),
  version: z.string(),
})

export const analyticsEventSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("signup"),
      ...analyticsEventBaseSchema.shape,
      payload: schemaSignUp,
    }),
    z.object({
      action: z.literal("plan_click"),
      ...analyticsEventBaseSchema.shape,
      payload: schemaPlanClick,
    }),
    z.object({
      action: z.literal("page_hit"),
      ...analyticsEventBaseSchema.shape,
      payload: schemaPageHit,
    }),
  ])
  .transform((event) => {
    return {
      ...event,
      payload: JSON.stringify(event.payload),
    }
  })

export const pageEventSchema = z.object({
  ...{ ...analyticsEventBaseSchema.shape, version: z.string().optional() },
  page_id: z.string(),
  plan_ids: z.array(z.string()).nullable(),
  url: z.string(),
  country: z.string(),
  city: z.string(),
  region: z.string(),
  latitude: z.string(),
  longitude: z.string(),
  device: z.string(),
  device_model: z.string(),
  device_vendor: z.string(),
  browser: z.string(),
  browser_version: z.string(),
  os: z.string(),
  os_version: z.string(),
  engine: z.string(),
  engine_version: z.string(),
  cpu_architecture: z.string(),
  bot: z.boolean(),
  referrer: z.string(),
  referrer_url: z.string(),
  ip: z.string(),
  continent: z.string(),
  locale: z.string(),
})

export const schemaPlanVersion = z.object({
  id: z.string(),
  project_id: z.string(),
  plan_id: z.string(),
  plan_slug: z.string(),
  plan_version: z.number(),
  currency: z.string(),
  payment_provider: z.string(),
  billing_interval: z.string(),
  billing_interval_count: z.number(),
  billing_anchor: z.string(),
  plan_type: z.string(),
  trial_units: z.number(),
  payment_method_required: z.boolean(),
  timestamp: z.string().datetime(),
})

export const schemaFeature = z.object({
  id: z.string(),
  project_id: z.string(),
  slug: z.string(),
  code: z.number(),
  timestamp: z.string().datetime(),
})

export const schemaPlanVersionFeature = z.object({
  id: z.string(),
  project_id: z.string(),
  plan_version_id: z.string(),
  feature_id: z.string(),
  feature_type: z.string(),
  config: z.string(),
  aggregation_method: z.string(),
  default_quantity: z.number().nullable(),
  limit: z.number().nullable(),
  metadata: metadataSchema,
  timestamp: z.string().datetime(),
})

export type PageAnalyticsEvent = z.infer<typeof pageEventSchema>
export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>
export type AnalyticsEventAction = z.infer<typeof analyticsEventSchema>["action"]
export type GetUsageResponse = z.infer<typeof getUsageResponseSchema>
export type AnalyticsFeatureMetadata = z.infer<typeof featureMetadataSchemaV1>
export type AnalyticsVerification = z.infer<typeof featureVerificationSchemaV1>
export type AnalyticsUsage = z.infer<typeof featureUsageSchemaV1>
export type AnalyticsEntitlementMeterFact = z.infer<typeof entitlementMeterFactSchemaV1>

// Plan conversion response schemas
export const planConversionResponseSchema = z.object({
  date: z.string(),
  plan_id: z.string(),
  plan_slug: z.string().nullable(),
  plan_version: z.string().nullable(),
  page_id: z.string().nullable(),
  page_views: z.number(),
  clicks: z.number(),
  conversions: z.number(),
  conversion_rate: z.number(),
  click_through_rate: z.number(),
  overall_conversion_rate: z.number(),
})

export const statsSchema = z.record(
  z.string(),
  z.object({
    total: z.number(),
    title: z.string(),
    description: z.string(),
    unit: z.string().optional(),
  })
)

export type PlanConversionResponse = z.infer<typeof planConversionResponseSchema>

export type PageCountryVisits = Awaited<ReturnType<Analytics["getCountryVisits"]>>["data"]
export type PageBrowserVisits = Awaited<ReturnType<Analytics["getBrowserVisits"]>>["data"]
export type PageOverview = Awaited<ReturnType<Analytics["getPagesOverview"]>>["data"]
export type FeaturesUsage = Awaited<ReturnType<Analytics["getFeaturesUsage"]>>["data"]
export type PlansConversion = Awaited<ReturnType<Analytics["getPlansConversion"]>>["data"]
export type Usage = Awaited<ReturnType<Analytics["getFeaturesUsagePeriod"]>>["data"]

export type Stats = z.infer<typeof statsSchema>
