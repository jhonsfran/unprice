"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { nFormatter } from "@unprice/db/utils"
import { formatMoney } from "@unprice/money"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import { Skeleton } from "@unprice/ui/skeleton"
import { BarChart3, Coins, Layers3, ReceiptText, TriangleAlert } from "lucide-react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { IntervalFilter } from "~/components/analytics/interval-filter"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

type CustomerMetricsPanelProps = {
  customerId: string
  invoiceCount: number
}

type UsageRow = RouterOutputs["analytics"]["getProjectUsage"]["usage"][number]
type TimeseriesRow = RouterOutputs["analytics"]["getProjectUsageTimeseries"]["timeseries"][number]

type SpendingSummary = {
  currency: string
  displayAmount: string
}

type TimeseriesPoint = {
  date: number
  dateLabel: string
  [feature: string]: string | number
}

const MONEY_DISPLAY_OPTIONS = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}

const TIMESERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

function formatUsage(value: number): string {
  return nFormatter(value, { digits: 1 })
}

function parseSpendingAmount(row: UsageRow): number {
  const amount = Number(row.spending.amount)
  return Number.isFinite(amount) ? amount : 0
}

function summarizeSpending(rows: UsageRow[]): SpendingSummary[] {
  const totalsByCurrency = new Map<string, number>()

  for (const row of rows) {
    totalsByCurrency.set(
      row.spending.currency,
      (totalsByCurrency.get(row.spending.currency) ?? 0) + parseSpendingAmount(row)
    )
  }

  return [...totalsByCurrency.entries()].map(([currency, amount]) => ({
    currency,
    displayAmount: formatMoney(amount.toString(), currency, MONEY_DISPLAY_OPTIONS),
  }))
}

function formatSpendingSummary(summary: SpendingSummary[]): string {
  if (summary.length === 0) {
    return "No spend"
  }

  return summary.map((item) => item.displayAmount).join(" + ")
}

function formatFeatureSpending(row: UsageRow): string {
  return formatMoney(row.spending.amount, row.spending.currency, MONEY_DISPLAY_OPTIONS)
}

function formatDateLabel(timestamp: number, format: string): string {
  const date = new Date(timestamp)

  if (format.includes("hh:mm")) {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function buildTimeseriesData(
  rows: TimeseriesRow[],
  dateFormat: string
): { data: TimeseriesPoint[]; features: string[] } {
  const featureSet = new Set<string>()
  const pointsByDate = new Map<number, TimeseriesPoint>()

  for (const row of rows) {
    featureSet.add(row.feature_slug)

    let point = pointsByDate.get(row.date)

    if (!point) {
      point = {
        date: row.date,
        dateLabel: formatDateLabel(row.date, dateFormat),
      }
      pointsByDate.set(row.date, point)
    }

    point[row.feature_slug] = row.usage ?? 0
  }

  const features = [...featureSet].sort()
  const data = [...pointsByDate.values()].sort((a, b) => a.date - b.date)

  for (const point of data) {
    for (const feature of features) {
      if (!(feature in point)) {
        point[feature] = 0
      }
    }
  }

  return { data, features }
}

export function CustomerMetricsPanelSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer usage</CardTitle>
        <CardDescription>Loading customer usage metrics...</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-4">
          {["features", "usage", "spend", "invoices"].map((item) => (
            <div key={`customer-usage-skeleton-${item}`} className="rounded-lg border p-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-3 h-8 w-20" />
            </div>
          ))}
        </div>

        <div className="overflow-hidden rounded-lg border border-border p-4">
          <Skeleton className="mb-4 h-4 w-32" />
          <Skeleton className="h-[220px] w-full" />
        </div>

        <div className="overflow-hidden rounded-lg border border-border">
          <Skeleton className="h-10 w-full" />
          <div className="space-y-3 p-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function CustomerMetricsErrorState({ error }: { error: string }) {
  return (
    <Card>
      <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between md:space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Customer usage</CardTitle>
          <CardDescription>Usage analytics could not be loaded right now.</CardDescription>
        </div>
        <IntervalFilter className="md:ml-auto" />
      </CardHeader>
      <CardContent>
        <EmptyPlaceholder className="h-[220px] w-auto border border-dashed">
          <EmptyPlaceholder.Icon>
            <TriangleAlert className="h-8 w-8 opacity-60" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>Unable to load usage</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>{error}</EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

function CustomerMetricsEmptyState({ intervalLabel }: { intervalLabel: string }) {
  return (
    <Card>
      <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between md:space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Customer usage</CardTitle>
          <CardDescription>Usage for this customer in the {intervalLabel}.</CardDescription>
        </div>
        <IntervalFilter className="md:ml-auto" />
      </CardHeader>
      <CardContent>
        <EmptyPlaceholder className="h-[220px] w-auto border border-dashed">
          <EmptyPlaceholder.Icon>
            <BarChart3 className="h-8 w-8 opacity-30" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>No usage metrics yet</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            No usage data was reported for this customer in the selected window.
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

export function CustomerMetricsPanel({ customerId, invoiceCount }: CustomerMetricsPanelProps) {
  const [intervalFilter] = useIntervalFilter()
  const trpc = useTRPC()
  const isNearRealtime = intervalFilter.intervalDays === 1

  const {
    data: usage,
    dataUpdatedAt,
    isFetching,
  } = useSuspenseQuery(
    trpc.analytics.getProjectUsage.queryOptions(
      {
        customerId,
        range: intervalFilter.name,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
        staleTime: isNearRealtime ? 30 * 1000 : 0,
        refetchInterval: isNearRealtime ? 60 * 1000 : (false as const),
        refetchOnWindowFocus: false,
      }
    )
  )

  const {
    data: timeseriesData,
    dataUpdatedAt: timeseriesUpdatedAt,
    isFetching: isTimeseriesFetching,
  } = useSuspenseQuery(
    trpc.analytics.getProjectUsageTimeseries.queryOptions(
      {
        customerId,
        range: intervalFilter.name,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
        staleTime: isNearRealtime ? 30 * 1000 : 0,
        refetchInterval: isNearRealtime ? 60 * 1000 : (false as const),
        refetchOnWindowFocus: false,
      }
    )
  )

  useQueryInvalidation({
    paramKey: intervalFilter.name,
    dataUpdatedAt,
    isFetching,
    getQueryKey: (param) => [
      ["analytics", "getProjectUsage"],
      {
        input: {
          customerId,
          range: param,
        },
        type: "query",
      },
    ],
  })

  useQueryInvalidation({
    paramKey: intervalFilter.name,
    dataUpdatedAt: timeseriesUpdatedAt,
    isFetching: isTimeseriesFetching,
    getQueryKey: (param) => [
      ["analytics", "getProjectUsageTimeseries"],
      {
        input: {
          customerId,
          range: param,
        },
        type: "query",
      },
    ],
  })

  if (usage.error || timeseriesData.error) {
    return <CustomerMetricsErrorState error={usage.error ?? timeseriesData.error ?? ""} />
  }

  const sortedUsage = [...usage.usage].sort((a, b) => {
    if (b.usage !== a.usage) {
      return b.usage - a.usage
    }

    return a.feature_slug.localeCompare(b.feature_slug)
  })

  const { data: timeseriesChartData, features: timeseriesFeatures } = buildTimeseriesData(
    timeseriesData.timeseries ?? [],
    intervalFilter.dateFormat
  )

  if (sortedUsage.length === 0 && timeseriesChartData.length === 0) {
    return <CustomerMetricsEmptyState intervalLabel={intervalFilter.label} />
  }

  const totalLatestUsage = sortedUsage.reduce((sum, row) => sum + row.usage, 0)
  const spendingSummary = summarizeSpending(sortedUsage)
  const consumedAmountLabel = formatSpendingSummary(spendingSummary)
  const timeseriesConfig = Object.fromEntries(
    timeseriesFeatures.map((feature, i) => [
      feature,
      { label: feature, color: TIMESERIES_COLORS[i % TIMESERIES_COLORS.length] },
    ])
  ) satisfies ChartConfig

  return (
    <Card>
      <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between md:space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Customer usage</CardTitle>
          <CardDescription>Usage for this customer in the {intervalFilter.label}.</CardDescription>
        </div>
        <IntervalFilter className="md:ml-auto" />
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-sm">Features with usage</p>
              <Layers3 className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="mt-1 font-semibold text-2xl text-foreground">{sortedUsage.length}</p>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-sm">Total latest usage</p>
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="mt-1 font-semibold text-2xl text-foreground">
              {formatUsage(totalLatestUsage)}
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-sm">Consumed amount</p>
              <Coins className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="mt-1 truncate font-semibold text-foreground text-xl">
              {consumedAmountLabel}
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-sm">Number of invoices</p>
              <ReceiptText className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="mt-1 font-semibold text-2xl text-foreground">{invoiceCount}</p>
          </div>
        </div>

        {timeseriesChartData.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-border p-4">
            <p className="mb-3 text-muted-foreground text-xs uppercase">Usage over time</p>
            <ChartContainer config={timeseriesConfig} className="h-[240px] w-full">
              <AreaChart
                accessibilityLayer
                data={timeseriesChartData}
                margin={{ left: 8, right: 8, top: 8, bottom: 8 }}
              >
                <CartesianGrid vertical={false} className="stroke-muted" />
                <XAxis
                  dataKey="dateLabel"
                  axisLine={false}
                  tickLine={false}
                  tickMargin={10}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tickMargin={10}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(value) => formatUsage(Number(value))}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      formatter={(value, name) => (
                        <>
                          <span>{String(name)}</span>
                          <span className="ml-auto font-medium font-mono text-foreground tabular-nums">
                            {formatUsage(Number(value))}
                          </span>
                        </>
                      )}
                    />
                  }
                />
                {timeseriesFeatures.map((feature, i) => (
                  <Area
                    key={feature}
                    type="monotone"
                    dataKey={feature}
                    stackId="usage"
                    fill={TIMESERIES_COLORS[i % TIMESERIES_COLORS.length]}
                    fillOpacity={0.15}
                    stroke={TIMESERIES_COLORS[i % TIMESERIES_COLORS.length]}
                    strokeWidth={2}
                  />
                ))}
              </AreaChart>
            </ChartContainer>
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[minmax(0,1fr)_6rem_7rem] items-center gap-4 bg-muted/40 px-4 py-2.5">
            <p className="text-muted-foreground text-xs uppercase tracking-wide">Feature</p>
            <p className="text-right text-muted-foreground text-xs uppercase tracking-wide">
              Usage
            </p>
            <p className="text-right text-muted-foreground text-xs uppercase tracking-wide">
              Consumed
            </p>
          </div>

          <div className="divide-y divide-border">
            {sortedUsage.map((row) => (
              <div
                key={`${customerId}:${row.feature_slug}`}
                className="grid grid-cols-[minmax(0,1fr)_6rem_7rem] items-center gap-4 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium text-sm">{row.feature_slug}</span>
                </div>
                <Badge
                  variant="outline"
                  className="justify-self-end font-mono text-xs tabular-nums"
                >
                  {formatUsage(row.usage)}
                </Badge>
                <span className="truncate text-right font-mono text-sm tabular-nums">
                  {formatFeatureSpending(row)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
