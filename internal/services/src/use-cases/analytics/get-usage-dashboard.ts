import {
  type Interval,
  analyticsIntervalSchema,
  prepareInterval,
  unitSpendingSchema,
} from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import { type SignedAmount, formatAmount, spendingOf } from "@unprice/money"
import { z } from "zod"
import {
  FEATURE_SLOTS,
  type FeatureUsageRow,
  customerOfKey,
  featureUsageQuery,
  splitOverflow,
  topPayersQuery,
} from "../../analytics/budget-journal"
import type { ServiceContext } from "../../context"

const MONEY_DISPLAY_OPTIONS = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}

export const usageDashboardFeatureSchema = z.object({
  featureSlug: z.string(),
  usage: z.number(),
  spending: z.array(unitSpendingSchema),
})

/** One feature's usage within one time bucket (not cumulative). */
export const usageDashboardTimeseriesRowSchema = z.object({
  date: z.number().int(),
  featureSlug: z.string(),
  usage: z.number(),
  spending: z.array(unitSpendingSchema),
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
    spending: z.array(unitSpendingSchema),
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

export type UsageDashboardMoney = z.infer<typeof unitSpendingSchema>
export type UsageDashboardFeature = z.infer<typeof usageDashboardFeatureSchema>
export type UsageDashboardTimeseriesRow = z.infer<typeof usageDashboardTimeseriesRowSchema>
export type UsageDashboardTopConsumer = z.infer<typeof usageDashboardTopConsumerSchema>
export type GetUsageDashboardInput = z.input<typeof getUsageDashboardInputSchema>
export type GetUsageDashboardOutput = z.infer<typeof getUsageDashboardOutputSchema>

export type GetUsageDashboardDeps = Pick<ServiceContext, "budgetJournal"> & {
  customers: Pick<ServiceContext["customers"], "findManyByIds">
  now?: () => number
}

type FeatureTotals = { quantity: SignedAmount; amounts: Map<string, SignedAmount> }

/**
 * Usage per feature over a range, read from the budget journal (ADR-0008 D7): what each payer
 * budget accepted, priced at ingestion. History lags the budget by the journal's export (minutes);
 * live numbers come from the payer budget. Each amount keeps the unit the budget exported;
 * amounts of different currencies or credit units are never added together.
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

  const [usage, top] = await Promise.all([
    deps.budgetJournal.read(
      featureUsageQuery({
        projectId: input.projectId,
        customerId: input.customerId,
        window,
        bucket,
      })
    ),
    input.customerId
      ? Promise.resolve(Ok([]))
      : loadTopConsumers({
          deps,
          projectId: input.projectId,
          window,
          limit: input.topConsumersLimit,
        }),
  ])
  if (usage.err) return Err(usage.err)
  if (top.err) return Err(top.err)
  const { rows, truncatedEvents: overflow } = splitOverflow(usage.val)
  const priced = rows.filter(
    (row): row is typeof row & { bucket: Date } => row.bucket instanceof Date
  )
  const features = buildFeatureRows(priced)
  const topConsumers = top.val

  return Ok(
    getUsageDashboardOutputSchema.parse({
      summary: buildSummary(features, priced),
      features,
      timeseries: buildTimeseries(priced),
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
  rows: readonly (FeatureUsageRow & { feature_slug: string; bucket: Date })[]
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
          spending: spendingByUnit(totals.amounts),
        }
      })
    )
}

function buildFeatureRows(
  rows: readonly (FeatureUsageRow & { feature_slug: string })[]
): UsageDashboardFeature[] {
  const byFeature = new Map<string, FeatureTotals>()
  for (const row of rows) {
    byFeature.set(row.feature_slug, add(byFeature.get(row.feature_slug) ?? zeroTotals(), row))
  }

  return [...byFeature.entries()]
    .map(([featureSlug, totals]) => ({
      featureSlug,
      usage: units(totals.quantity),
      spending: spendingByUnit(totals.amounts),
    }))
    .sort((a, b) => b.usage - a.usage || a.featureSlug.localeCompare(b.featureSlug))
}

function buildSummary(
  features: readonly UsageDashboardFeature[],
  rows: readonly FeatureUsageRow[]
): GetUsageDashboardOutput["summary"] {
  const amounts = new Map<string, SignedAmount>()
  for (const row of rows) addAmount(amounts, row.unit, row.amount)
  return {
    featureCount: features.length,
    totalLatestUsage: features.reduce((sum, feature) => sum + feature.usage, 0),
    spending: spendingByUnit(amounts),
  }
}

async function loadTopConsumers({
  deps,
  projectId,
  window,
  limit,
}: {
  deps: GetUsageDashboardDeps
  projectId: string
  window: { from: Date; to: Date }
  limit: number
}): Promise<Result<UsageDashboardTopConsumer[], FetchError>> {
  const top = await deps.budgetJournal.read(topPayersQuery({ projectId, window, limit }))
  if (top.err) return Err(top.err)

  const rows = top.val.flatMap((row) => {
    const customerId = customerOfKey(row.budget_key)
    return customerId ? [{ ...row, customerId }] : []
  })
  if (rows.length === 0) return Ok([])

  const found = await deps.customers.findManyByIds({
    projectId,
    ids: rows.map((row) => row.customerId),
  })
  if (found.err) return Err(found.err)

  const byId = new Map(found.val.map((customer) => [customer.id, customer]))
  const consumers = new Map<
    string,
    { customer: (typeof found.val)[number]; events: number; amounts: Map<string, SignedAmount> }
  >()
  for (const row of rows) {
    const customer = byId.get(row.customerId)
    if (!customer) continue
    const consumer = consumers.get(row.customerId) ?? { customer, events: 0, amounts: new Map() }
    consumer.events += row.events
    addAmount(consumer.amounts, row.unit, row.amount)
    consumers.set(row.customerId, consumer)
  }
  return Ok(
    [...consumers.values()].map(({ customer, events, amounts }) => ({
      customerId: customer.id,
      email: customer.email,
      name: customer.name,
      totalUsage: events,
      displaySpending: spendingByUnit(amounts)
        .map((amount) => amount.displayAmount)
        .join(" + "),
    }))
  )
}

const zeroTotals = (): FeatureTotals => ({ quantity: BigInt(0), amounts: new Map() })

function add(totals: FeatureTotals, row: FeatureUsageRow): FeatureTotals {
  addAmount(totals.amounts, row.unit, row.amount)
  return { quantity: totals.quantity + row.quantity, amounts: totals.amounts }
}

function addAmount(amounts: Map<string, SignedAmount>, unit: string, amount: SignedAmount): void {
  amounts.set(unit, (amounts.get(unit) ?? BigInt(0)) + amount)
}

function spendingByUnit(amounts: ReadonlyMap<string, SignedAmount>): UsageDashboardMoney[] {
  return [...amounts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([unit, amount]) => spendingOf(amount, unit, MONEY_DISPLAY_OPTIONS))
}

/** A quantity at the ledger scale as the number of units it counts. */
function units(quantity: SignedAmount): number {
  return Number(formatAmount(quantity))
}
