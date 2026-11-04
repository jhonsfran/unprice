import { inArray } from "@unprice/db"
import type { Database } from "@unprice/db"
import { customers } from "@unprice/db/schema"
import {
  type Currency,
  type Interval,
  analyticsIntervalSchema,
  prepareInterval,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import { type SignedAmount, formatAmount, formatMoney } from "@unprice/money"
import { z } from "zod"
import type { AnalyticsService } from "../../analytics"
import { FEATURE_SLOTS, type FeatureUsageRow, customerOfKey } from "../../analytics/budget-journal"

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

/** One feature's usage within one time bucket (not cumulative). */
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
  /** Usage events the customer's payer budget accepted in the range. */
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
  /** Partial-data notes: the dashboard still renders. */
  warnings: z.array(z.string()).optional(),
  error: z.string().optional(),
})

export type UsageDashboardMoney = z.infer<typeof usageDashboardMoneySchema>
export type UsageDashboardFeature = z.infer<typeof usageDashboardFeatureSchema>
export type UsageDashboardTimeseriesRow = z.infer<typeof usageDashboardTimeseriesRowSchema>
export type UsageDashboardTopConsumer = z.infer<typeof usageDashboardTopConsumerSchema>
export type GetUsageDashboardInput = z.input<typeof getUsageDashboardInputSchema>
export type GetUsageDashboardOutput = z.infer<typeof getUsageDashboardOutputSchema>

export type GetUsageDashboardDeps = {
  analytics: Pick<AnalyticsService, "getFeatureUsage" | "getTopPayers">
  db: Database
  now?: () => number
}

type FeatureTotals = { quantity: SignedAmount; amount: SignedAmount }

/**
 * Usage per feature over a range, read from the budget journal (ADR-0008 D7): what each payer
 * budget accepted, priced at ingestion. History lags the budget by the journal's export (minutes);
 * live numbers come from the payer budget. Amounts are shown in the project's default currency,
 * which is the payer budgets' unit for money plans.
 */
export async function getUsageDashboard(
  deps: GetUsageDashboardDeps,
  rawInput: GetUsageDashboardInput
): Promise<Result<GetUsageDashboardOutput, FetchError>> {
  const input = getUsageDashboardInputSchema.parse(rawInput)
  const generatedAt = deps.now?.() ?? Date.now()
  const interval = prepareInterval(input.range, generatedAt)
  const bucket = interval.granularity === "hour" ? "hour" : "day"
  const window = {
    from: new Date(bucket === "hour" ? floorUtcHour(interval.start) : floorUtcDay(interval.start)),
    to: new Date(interval.end),
  }

  const [currency, usage] = await Promise.all([
    projectCurrency(deps.db, input.projectId),
    deps.analytics.getFeatureUsage({
      projectId: input.projectId,
      customerId: input.customerId,
      window,
      bucket,
    }),
  ])
  if (currency.err) return Err(currency.err)
  if (usage.err) return Err(usage.err)

  const priced = usage.val.filter(
    (row): row is FeatureUsageRow & { feature_slug: string; bucket: Date } =>
      row.feature_slug !== null && row.bucket instanceof Date
  )
  const overflow = usage.val
    .filter((row) => row.feature_slug === null)
    .reduce((sum, row) => sum + row.events, 0)

  const features = buildFeatureRows(priced, currency.val)

  let topConsumers: UsageDashboardTopConsumer[] = []
  if (!input.customerId) {
    const top = await loadTopConsumers({
      deps,
      projectId: input.projectId,
      window,
      limit: input.topConsumersLimit,
      currency: currency.val,
    })
    if (top.err) return Err(top.err)
    topConsumers = top.val
  }

  return Ok(
    getUsageDashboardOutputSchema.parse({
      summary: buildSummary(features, priced, currency.val),
      features,
      timeseries: buildTimeseries(priced, currency.val),
      topConsumers,
      freshness: {
        generatedAt,
        dataFrom: window.from.getTime(),
        dataTo: window.to.getTime(),
      },
      ...(overflow > 0 && {
        warnings: [
          `${overflow} events fed more than ${FEATURE_SLOTS} features; their other features are not shown.`,
        ],
      }),
    })
  )
}

function floorUtcHour(timestamp: number): number {
  const date = new Date(timestamp)
  date.setUTCMinutes(0, 0, 0)
  return date.getTime()
}

function floorUtcDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setUTCHours(0, 0, 0, 0)
  return date.getTime()
}

async function projectCurrency(db: Database, projectId: string) {
  return wrapResult(
    db.query.projects
      .findFirst({
        columns: { defaultCurrency: true },
        where: (table, { eq }) => eq(table.id, projectId),
      })
      .then((project) => (project?.defaultCurrency ?? "USD") as Currency),
    (error) =>
      new FetchError({
        message: error.message,
        retry: false,
        context: { url: "db:projects", method: "SELECT", projectId },
      })
  )
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

export function hasUsageDashboardEvidence(output: GetUsageDashboardOutput): boolean {
  return (
    output.features.length > 0 || output.timeseries.length > 0 || output.topConsumers.length > 0
  )
}

/** Every bucket that has usage, each with a row per feature seen in the range (zero when idle). */
function buildTimeseries(
  rows: readonly (FeatureUsageRow & { feature_slug: string; bucket: Date })[],
  currency: Currency
): UsageDashboardTimeseriesRow[] {
  const byBucket = new Map<number, Map<string, FeatureTotals>>()
  const slugs = new Set<string>()
  for (const row of rows) {
    slugs.add(row.feature_slug)
    const date = row.bucket.getTime()
    const features = byBucket.get(date) ?? new Map<string, FeatureTotals>()
    byBucket.set(date, features)
    const totals = features.get(row.feature_slug) ?? zeroTotals()
    features.set(row.feature_slug, add(totals, row))
  }

  const featureSlugs = [...slugs].sort()
  return [...byBucket.keys()]
    .sort((a, b) => a - b)
    .flatMap((date) =>
      featureSlugs.map((featureSlug) => {
        const totals = byBucket.get(date)?.get(featureSlug) ?? zeroTotals()
        return {
          date,
          featureSlug,
          usage: units(totals.quantity),
          spending: money(totals.amount, currency),
        }
      })
    )
}

function buildFeatureRows(
  rows: readonly (FeatureUsageRow & { feature_slug: string })[],
  currency: Currency
): UsageDashboardFeature[] {
  const byFeature = new Map<string, FeatureTotals>()
  for (const row of rows) {
    byFeature.set(row.feature_slug, add(byFeature.get(row.feature_slug) ?? zeroTotals(), row))
  }

  return [...byFeature.entries()]
    .map(([featureSlug, totals]) => ({
      featureSlug,
      usage: units(totals.quantity),
      spending: money(totals.amount, currency),
    }))
    .sort((a, b) => b.usage - a.usage || a.featureSlug.localeCompare(b.featureSlug))
}

function buildSummary(
  features: readonly UsageDashboardFeature[],
  rows: readonly FeatureUsageRow[],
  currency: Currency
): GetUsageDashboardOutput["summary"] {
  const amount = rows.reduce((sum, row) => sum + row.amount, BigInt(0))
  return {
    featureCount: features.length,
    totalLatestUsage: features.reduce((sum, feature) => sum + feature.usage, 0),
    spending: rows.length === 0 ? [] : [money(amount, currency)],
  }
}

async function loadTopConsumers({
  deps,
  projectId,
  window,
  limit,
  currency,
}: {
  deps: GetUsageDashboardDeps
  projectId: string
  window: { from: Date; to: Date }
  limit: number
  currency: Currency
}): Promise<Result<UsageDashboardTopConsumer[], FetchError>> {
  const top = await deps.analytics.getTopPayers({ projectId, window, limit })
  if (top.err) return Err(top.err)

  const rows = top.val.flatMap((row) => {
    const customerId = customerOfKey(row.budget_key)
    return customerId ? [{ ...row, customerId }] : []
  })
  if (rows.length === 0) return Ok([])

  const found = await wrapResult(
    deps.db
      .select({ id: customers.id, email: customers.email, name: customers.name })
      .from(customers)
      .where(
        inArray(
          customers.id,
          rows.map((row) => row.customerId)
        )
      ),
    (error) =>
      new FetchError({
        message: error.message,
        retry: false,
        context: { url: "db:customers", method: "SELECT", projectId },
      })
  )
  if (found.err) return Err(found.err)

  const byId = new Map(found.val.map((customer) => [customer.id, customer]))
  return Ok(
    rows.flatMap((row) => {
      const customer = byId.get(row.customerId)
      if (!customer) return []
      return [
        {
          customerId: row.customerId,
          email: customer.email,
          name: customer.name,
          totalUsage: row.events,
          displaySpending: money(row.amount, currency).displayAmount,
        },
      ]
    })
  )
}

const zeroTotals = (): FeatureTotals => ({ quantity: BigInt(0), amount: BigInt(0) })

function add(totals: FeatureTotals, row: FeatureUsageRow): FeatureTotals {
  return { quantity: totals.quantity + row.quantity, amount: totals.amount + row.amount }
}

/** A quantity at the ledger scale as the number of units it counts. */
function units(quantity: SignedAmount): number {
  return Number(formatAmount(quantity))
}

function money(amount: SignedAmount, currency: Currency): UsageDashboardMoney {
  const decimal = formatAmount(amount)
  return {
    amount: decimal,
    currency,
    displayAmount: formatMoney(decimal, currency, MONEY_DISPLAY_OPTIONS),
  }
}
