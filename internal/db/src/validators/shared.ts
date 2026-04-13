import * as z from "zod"

import { formatInTimeZone, toZonedTime } from "date-fns-tz"
import { extendZodWithOpenApi } from "zod-openapi"
import {
  AGGREGATION_METHODS,
  BILLING_INTERVALS,
  BILLING_PERIOD_STATUS,
  BILLING_PERIOD_TYPE,
  COLLECTION_METHODS,
  CURRENCIES,
  DUE_BEHAVIOUR,
  ENTITLEMENT_MERGING_POLICY,
  FEATURE_CONFIG_TYPES,
  FEATURE_TYPES,
  GRANT_TYPES,
  INVOICE_STATUS,
  LEDGER_ENTRY_TYPES,
  LEDGER_SETTLEMENT_STATUSES,
  LEDGER_SETTLEMENT_TYPES,
  OVERAGE_STRATEGIES,
  PAYMENT_PROVIDERS,
  PLAN_TYPES,
  SUBJECT_TYPES,
  SUBSCRIPTION_STATUS,
  TIER_MODES,
  USAGE_MODES,
  WHEN_TO_BILLING,
} from "../utils"

extendZodWithOpenApi(z)

export const subjectTypeSchema = z.enum(SUBJECT_TYPES)
export const grantTypeSchema = z.enum(GRANT_TYPES)
export const paymentProviderSchema = z.enum(PAYMENT_PROVIDERS)
export const currencySchema = z.enum(CURRENCIES)
export const typeFeatureSchema = z.enum(FEATURE_TYPES)
export const billingPeriodStatusSchema = z.enum(BILLING_PERIOD_STATUS)
export const billingPeriodTypeSchema = z.enum(BILLING_PERIOD_TYPE)
export const usageModeSchema = z.enum(USAGE_MODES)
export const aggregationMethodSchema = z
  .enum(AGGREGATION_METHODS)
  .describe(
    "How to aggregate usage events within the current billing period. 'sum' totals values, 'count' counts events, 'max' keeps the highest value, and 'latest' keeps the most recent value."
  )

export const meterConfigSchema = z
  .object({
    eventId: z.string().min(1),
    eventSlug: z.string().min(1),
    aggregationMethod: aggregationMethodSchema,
    aggregationField: z.string().min(1).optional(),
    // TODO: implement this later
    filters: z.record(z.string(), z.string()).optional(),
    groupBy: z.array(z.string()).optional(),
    windowSize: z.enum(["MINUTE", "HOUR", "DAY"]).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.aggregationMethod !== "count" && !data.aggregationField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Aggregation field is required unless the aggregation method is count",
        path: ["aggregationField"],
      })
    }
  })

export const tierModeSchema = z.enum(TIER_MODES)
export const featureConfigType = z.enum(FEATURE_CONFIG_TYPES)
export const unitSchema = z.coerce.number().int().min(1)
export const collectionMethodSchema = z.enum(COLLECTION_METHODS)
export const monthsSchema = z.coerce.number().int().min(1).max(12)
export const yearsSchema = z.coerce.number().int().min(2000).max(2100)
export const whenToBillSchema = z.enum(WHEN_TO_BILLING)
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUS)
export const dueBehaviourSchema = z.enum(DUE_BEHAVIOUR)
export const invoiceStatusSchema = z.enum(INVOICE_STATUS)
export const ledgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPES)
export const ledgerSettlementTypeSchema = z.enum(LEDGER_SETTLEMENT_TYPES)
export const ledgerSettlementStatusSchema = z.enum(LEDGER_SETTLEMENT_STATUSES)
export const billingAnchorSchema = z.union([
  z.coerce.number().int().min(1).max(31).openapi({
    description:
      "Days of the month. Pick a number between 1 and 31, if the month has less days, it will be the last day of the month",
  }),
  z.literal("dayOfCreation").openapi({
    description: "the day of the creation of the subscription as the billing anchor",
  }),
])

export const billingIntervalSchema = z.enum(BILLING_INTERVALS)
export const billingIntervalCountSchema = z.coerce.number().int().min(1).max(60)
export const planTypeSchema = z.enum(PLAN_TYPES)

export const unpriceProjectErrorSchema = z.enum([
  "PROJECT_FEATURES_NOT_FOUND",
  "PROJECT_NOT_FOUND",
  "PROJECT_NOT_ENABLED",
])

export const unpricePlanErrorSchema = z.enum(["PLAN_VERSION_NOT_FOUND"])

export const deniedReasonSchema = z.enum([
  "INVALID_USAGE",
  "ERROR_SYNCING_ENTITLEMENTS_LAST_USAGE",
  "FLAT_FEATURE_NOT_ALLOWED_REPORT_USAGE",
  "ENTITLEMENT_OUTSIDE_OF_CURRENT_BILLING_WINDOW",
  "ERROR_RESETTING_DO",
  "RATE_LIMITED",
  "ENTITLEMENT_NOT_FOUND",
  "LIMIT_EXCEEDED",
  "ENTITLEMENT_EXPIRED",
  "ENTITLEMENT_NOT_ACTIVE",
  "DO_NOT_INITIALIZED",
  "INCORRECT_USAGE_REPORTING",
  "ERROR_INSERTING_USAGE_DO",
  "ERROR_INSERTING_VERIFICATION_DO",
  "PROJECT_DISABLED",
  "CUSTOMER_DISABLED",
  "SUBSCRIPTION_DISABLED",
  "FETCH_ERROR",
  "SUBSCRIPTION_ERROR",
  "ENTITLEMENT_ERROR",
  "SUBSCRIPTION_EXPIRED",
  "NO_DEFAULT_PLAN_FOUND",
  "SUBSCRIPTION_NOT_ACTIVE",
  "PHASE_NOT_CREATED",
  "FEATURE_NOT_FOUND_IN_SUBSCRIPTION",
  "CUSTOMER_NOT_FOUND",
  "CUSTOMER_EXTERNAL_ID_CONFLICT",
  "CUSTOMER_ENTITLEMENTS_NOT_FOUND",
  "FEATURE_TYPE_NOT_SUPPORTED",
  "PROJECT_DISABLED",
  "CUSTOMER_DISABLED",
  "PLAN_VERSION_NOT_PUBLISHED",
  "PLAN_VERSION_NOT_ACTIVE",
  "PAYMENT_PROVIDER_CONFIG_NOT_FOUND",
  "ENTITLEMENT_EXPIRED",
  "ENTITLEMENT_NOT_ACTIVE",
  "CUSTOMER_SESSION_NOT_CREATED",
  "CUSTOMER_SESSION_NOT_FOUND",
  "PLAN_VERSION_NOT_FOUND",
  "PAYMENT_PROVIDER_ERROR",
  "SUBSCRIPTION_NOT_CREATED",
  "CUSTOMER_NOT_CREATED",
  "SUBSCRIPTION_NOT_CANCELED",
  "CUSTOMER_PHASE_NOT_FOUND",
  "CURRENCY_MISMATCH",
  "BILLING_INTERVAL_MISMATCH",
  "ENTITLEMENT_NOT_FOUND",
  "SUBSCRIPTION_NOT_FOUND",
  "INVALID_ENTITLEMENT_TYPE",
  "NO_ACTIVE_PHASE_FOUND",
])

// --- Helper Function ---
/**
 * Gets the start of the day for a given date, explicitly in UTC.
 * This is crucial to avoid server timezone influencing the result.
 */
export function getStartOfDayInUtc(date: Date): Date {
  // Format the date to a 'YYYY-MM-DD' string IN UTC, then parse it back.
  // This effectively strips the time components according to UTC, not the host timezone.
  const dateString = formatInTimeZone(date, "UTC", "yyyy-MM-dd")
  return toZonedTime(dateString, "UTC")
}

export const dateToUnixMilli = z
  .string()
  .transform((t) => new Date(t.split(" ").at(0) ?? t).getTime())

export const datetimeToUnixMilli = z.string().transform((t) => new Date(t).getTime())

// transforms the date to unix timestamp
// allow dates or numbers and transforms them to numbers
export const datetimeToUnix = z.coerce
  .date({
    message: "Date is required",
  })
  .transform((val) => {
    return val.getTime()
  })

export const billingConfigSchema = z.object({
  name: z.string().min(1),
  billingInterval: billingIntervalSchema,
  billingIntervalCount: billingIntervalCountSchema,
  billingAnchor: billingAnchorSchema,
  planType: planTypeSchema,
})

export const resetConfigSchema = z.object({
  name: z.string().min(1),
  resetInterval: billingIntervalSchema,
  resetIntervalCount: billingIntervalCountSchema,
  resetAnchor: billingAnchorSchema,
  planType: planTypeSchema,
})

export const entitlementMergingPolicySchema = z.enum(ENTITLEMENT_MERGING_POLICY)
export const overageStrategySchema = z.enum(OVERAGE_STRATEGIES)

export type Currency = z.infer<typeof currencySchema>
export type PaymentProvider = z.infer<typeof paymentProviderSchema>
export type FeatureType = z.infer<typeof typeFeatureSchema>
export type FeatureConfigType = z.infer<typeof featureConfigType>
export type Year = z.infer<typeof yearsSchema>
export type Month = z.infer<typeof monthsSchema>
export type AggregationMethod = z.infer<typeof aggregationMethodSchema>
export type WhenToBill = z.infer<typeof whenToBillSchema>
export type BillingAnchor = z.infer<typeof billingAnchorSchema>
export type CollectionMethod = z.infer<typeof collectionMethodSchema>
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>
export type LedgerEntryType = z.infer<typeof ledgerEntryTypeSchema>
export type LedgerSettlementType = z.infer<typeof ledgerSettlementTypeSchema>
export type LedgerSettlementStatus = z.infer<typeof ledgerSettlementStatusSchema>
export type BillingInterval = z.infer<typeof billingIntervalSchema>
export type PlanType = z.infer<typeof planTypeSchema>
export type BillingConfig = z.infer<typeof billingConfigSchema>
export type ResetConfig = z.infer<typeof resetConfigSchema>
export type MeterConfig = z.infer<typeof meterConfigSchema>
export type EntitlementMergingPolicy = z.infer<typeof entitlementMergingPolicySchema>
export type OverageStrategy = z.infer<typeof overageStrategySchema>
export type GrantType = z.infer<typeof grantTypeSchema>
