import {
  type FeatureUsagePeriodRow,
  type FeatureUsageTimeseriesRow,
  type Interval,
  type TopConsumerRow,
  analyticsIntervalSchema,
  prepareInterval,
} from "@unprice/analytics"
import { inArray } from "@unprice/db"
import type { Database } from "@unprice/db"
import { customers } from "@unprice/db/schema"
import type { Currency } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import { formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"
import { z } from "zod"

const MONEY_DISPLAY_OPTIONS = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}

const usageDashboardMoneySchema = z.object({
  amount: z.string(),
  currency: z.string().length(3),
  displayAmount: z.string(),
})

export const usageDashboardFeatureSchema = z.object({
  featureSlug: z.string(),
  usage: z.number(),
  spending: usageDashboardMoneySchema,
})

export const usageDashboardTimeseriesRowSchema = z.object({
  date: z.number().int(),
  featureSlug: z.string(),
  usage: z.number(),
  spending: usageDashboardMoneySchema,
})

export const usageDashboardTopConsumerSchema = z.object({
  customerId: z.string(),
  email: z.string(),
  name: z.string(),
  totalUsage: z.number(),
  displaySpending: z.string(),
})

export const getUsageDashboardInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string().optional(),
  range: analyticsIntervalSchema,
  topConsumersLimit: z.number().int().min(1).max(20).optional().default(10),
})

export const getUsageDashboardOutputSchema = z.object({
  summary: z.object({
    featureCount: z.number().int(),
    totalLatestUsage: z.number(),
    spending: z.array(usageDashboardMoneySchema),
  }),
  features: z.array(usageDashboardFeatureSchema),
  timeseries: z.array(usageDashboardTimeseriesRowSchema),
  topConsumers: z.array(usageDashboardTopConsumerSchema),
  freshness: z.object({
    generatedAt: z.number().int(),
    dataFrom: z.number().int(),
    dataTo: z.number().int(),
  }),
  error: z.string().optional(),
})

export type UsageDashboardMoney = z.infer<typeof usageDashboardMoneySchema>
export type UsageDashboardFeature = z.infer<typeof usageDashboardFeatureSchema>
export type UsageDashboardTimeseriesRow = z.infer<typeof usageDashboardTimeseriesRowSchema>
export type UsageDashboardTopConsumer = z.infer<typeof usageDashboardTopConsumerSchema>
export type GetUsageDashboardInput = z.input<typeof getUsageDashboardInputSchema>
export type GetUsageDashboardOutput = z.infer<typeof getUsageDashboardOutputSchema>

export type GetUsageDashboardAnalytics = {
  getFeaturesUsageTimeseries(params: {
    project_id: string
    customer_id?: string
    start?: number
    end?: number
  }): Promise<{ data?: FeatureUsageTimeseriesRow[] }>
  getFeaturesUsagePeriod(params: {
    project_id: string
    customer_id?: string
    start?: number
    end?: number
  }): Promise<{ data?: FeatureUsagePeriodRow[] }>
  getTopConsumers(params: {
    project_id: string
    start?: number
    end?: number
    limit?: number
  }): Promise<{ data?: TopConsumerRow[] }>
}

export type GetUsageDashboardDeps = {
  analytics: GetUsageDashboardAnalytics
  db: Database
  now?: () => number
}

type GetUsageDashboardFailure = FetchError

type FeatureState = {
  usage: number
  amountAfter: number
  currency: string
}

export async function getUsageDashboard(
  deps: GetUsageDashboardDeps,
  rawInput: GetUsageDashboardInput
): Promise<Result<GetUsageDashboardOutput, GetUsageDashboardFailure>> {
  const input = getUsageDashboardInputSchema.parse(rawInput)
  const interval = prepareInterval(input.range)
  const generatedAt = deps.now?.() ?? Date.now()
  const usageQuery = {
    project_id: input.projectId,
    ...(input.customerId ? { customer_id: input.customerId } : {}),
    start: interval.start,
    end: interval.end,
  }

  const [timeseriesResult, periodResult] = await Promise.all([
    wrapResult(
      deps.analytics.getFeaturesUsageTimeseries(usageQuery),
      (error) =>
        new FetchError({
          message: error.message,
          retry: true,
          context: {
            url: "tinybird:v1_get_feature_usage_timeseries",
            method: "GET",
            projectId: input.projectId,
            customerId: input.customerId,
          },
        })
    ),
    wrapResult(
      deps.analytics.getFeaturesUsagePeriod(usageQuery),
      (error) =>
        new FetchError({
          message: error.message,
          retry: true,
          context: {
            url: "tinybird:v1_get_feature_usage_period",
            method: "GET",
            projectId: input.projectId,
            customerId: input.customerId,
          },
        })
    ),
  ])

  if (timeseriesResult.err) {
    return Err(timeseriesResult.err)
  }

  if (periodResult.err) {
    return Err(periodResult.err)
  }

  const timeseriesRows = timeseriesResult.val.data ?? []
  const periodRows = periodResult.val.data ?? []
  const denseTimeseries = buildDenseTimeseries(timeseriesRows)
  const features = buildFeatureRows(periodRows)
  const summary = buildSummary(features)

  let topConsumers: UsageDashboardTopConsumer[] = []

  if (!input.customerId) {
    const topConsumersResult = await loadTopConsumers({
      deps,
      projectId: input.projectId,
      start: interval.start,
      end: interval.end,
      limit: input.topConsumersLimit,
    })

    if (topConsumersResult.err) {
      return Err(topConsumersResult.err)
    }

    topConsumers = topConsumersResult.val
  }

  const output: GetUsageDashboardOutput = {
    summary,
    features,
    timeseries: denseTimeseries,
    topConsumers,
    freshness: {
      generatedAt,
      dataFrom: interval.start,
      dataTo: interval.end,
    },
  }

  return Ok(getUsageDashboardOutputSchema.parse(output))
}

export function emptyUsageDashboardOutput(
  range: Interval,
  error?: string
): GetUsageDashboardOutput {
  const interval = prepareInterval(range)

  return {
    summary: {
      featureCount: 0,
      totalLatestUsage: 0,
      spending: [],
    },
    features: [],
    timeseries: [],
    topConsumers: [],
    freshness: {
      generatedAt: Date.now(),
      dataFrom: interval.start,
      dataTo: interval.end,
    },
    ...(error ? { error } : {}),
  }
}

function buildDenseTimeseries(rows: FeatureUsageTimeseriesRow[]): UsageDashboardTimeseriesRow[] {
  const rowsByDate = new Map<number, FeatureUsageTimeseriesRow[]>()
  const featureSlugs = new Set<string>()

  for (const row of rows) {
    featureSlugs.add(row.feature_slug)

    const existing = rowsByDate.get(row.date) ?? []
    existing.push(row)
    rowsByDate.set(row.date, existing)
  }

  const features = [...featureSlugs].sort()
  const dates = [...rowsByDate.keys()].sort((a, b) => a - b)
  const state = new Map<string, FeatureState>()
  const denseRows: UsageDashboardTimeseriesRow[] = []

  for (const date of dates) {
    for (const row of rowsByDate.get(date) ?? []) {
      state.set(row.feature_slug, {
        usage: row.usage ?? 0,
        amountAfter: row.amount_after ?? 0,
        currency: row.currency ?? "USD",
      })
    }

    for (const featureSlug of features) {
      const current = state.get(featureSlug) ?? {
        usage: 0,
        amountAfter: 0,
        currency: "USD",
      }

      denseRows.push({
        date,
        featureSlug,
        usage: current.usage,
        spending: formatLedgerMoney(current.amountAfter, current.currency),
      })
    }
  }

  return denseRows
}

function buildFeatureRows(rawRows: FeatureUsagePeriodRow[]): UsageDashboardFeature[] {
  const aggregates = new Map<
    string,
    { totalUsage: number; totalAmountAfter: number; currency: string }
  >()

  for (const row of rawRows) {
    const existing = aggregates.get(row.feature_slug)
    const usage = row.usage ?? row.value_after ?? 0
    const amountAfter = row.amount_after ?? 0
    const currency = row.currency ?? "USD"

    if (existing) {
      existing.totalUsage += usage
      existing.totalAmountAfter += amountAfter
      // Keep the most recent currency (last row wins since rows are date-ordered)
      existing.currency = currency
    } else {
      aggregates.set(row.feature_slug, {
        totalUsage: usage,
        totalAmountAfter: amountAfter,
        currency,
      })
    }
  }

  return [...aggregates.entries()]
    .map(([featureSlug, agg]) => ({
      featureSlug,
      usage: agg.totalUsage,
      spending: formatLedgerMoney(agg.totalAmountAfter, agg.currency),
    }))
    .sort((a, b) => {
      if (b.usage !== a.usage) {
        return b.usage - a.usage
      }

      return a.featureSlug.localeCompare(b.featureSlug)
    })
}

function buildSummary(features: UsageDashboardFeature[]): GetUsageDashboardOutput["summary"] {
  const totalsByCurrency = new Map<string, number>()

  for (const feature of features) {
    const amount = Number(feature.spending.amount)

    if (!Number.isFinite(amount)) {
      continue
    }

    totalsByCurrency.set(
      feature.spending.currency,
      (totalsByCurrency.get(feature.spending.currency) ?? 0) + amount
    )
  }

  return {
    featureCount: features.length,
    totalLatestUsage: features.reduce((sum, feature) => sum + feature.usage, 0),
    spending: [...totalsByCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => formatMajorMoney(amount, currency)),
  }
}

async function loadTopConsumers({
  deps,
  projectId,
  start,
  end,
  limit,
}: {
  deps: GetUsageDashboardDeps
  projectId: string
  start: number
  end: number
  limit: number
}): Promise<Result<UsageDashboardTopConsumer[], FetchError>> {
  const analyticsResult = await wrapResult(
    deps.analytics.getTopConsumers({
      project_id: projectId,
      start,
      end,
      limit,
    }),
    (error) =>
      new FetchError({
        message: error.message,
        retry: true,
        context: {
          url: "tinybird:v1_get_top_consumers",
          method: "GET",
          projectId,
        },
      })
  )

  if (analyticsResult.err) {
    return Err(analyticsResult.err)
  }

  const rows = analyticsResult.val.data ?? []

  if (rows.length === 0) {
    return Ok([])
  }

  const customerIds = rows.map((row) => row.customer_id)

  const dbResult = await wrapResult(
    deps.db
      .select({ id: customers.id, email: customers.email, name: customers.name })
      .from(customers)
      .where(inArray(customers.id, customerIds)),
    (error) =>
      new FetchError({
        message: error.message,
        retry: false,
        context: {
          url: "db:customers",
          method: "SELECT",
          projectId,
        },
      })
  )

  if (dbResult.err) {
    return Err(dbResult.err)
  }

  const customerMap = new Map(dbResult.val.map((customer) => [customer.id, customer]))

  return Ok(
    rows
      .map((row) => mapTopConsumer(row, customerMap))
      .filter((row): row is UsageDashboardTopConsumer => row !== null)
  )
}

function mapTopConsumer(
  row: TopConsumerRow,
  customerMap: Map<string, { id: string; email: string; name: string }>
): UsageDashboardTopConsumer | null {
  const customer = customerMap.get(row.customer_id)

  if (!customer) {
    return null
  }

  const currency = row.currency ?? "USD"

  return {
    customerId: row.customer_id,
    email: customer.email,
    name: customer.name,
    totalUsage: row.total_usage ?? 0,
    displaySpending: formatLedgerMoney(row.total_amount_after ?? 0, currency).displayAmount,
  }
}

function formatLedgerMoney(amountAfter: number, rawCurrency: string): UsageDashboardMoney {
  const currency = normalizeCurrency(rawCurrency)
  const amount = trimInsignificantZeros(toDecimal(fromLedgerMinor(amountAfter, currency)))

  return {
    amount,
    currency,
    displayAmount: formatMoney(amount, currency, MONEY_DISPLAY_OPTIONS),
  }
}

function formatMajorMoney(amount: number, rawCurrency: string): UsageDashboardMoney {
  const currency = normalizeCurrency(rawCurrency)
  const value = trimInsignificantZeros(amount.toFixed(8))

  return {
    amount: value,
    currency,
    displayAmount: formatMoney(value, currency, MONEY_DISPLAY_OPTIONS),
  }
}

function normalizeCurrency(currency: string): Currency {
  return (currency || "USD") as Currency
}

function trimInsignificantZeros(amount: string): string {
  if (!amount.includes(".")) {
    return amount
  }

  return amount.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "")
}
