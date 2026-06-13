"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { nFormatter } from "@unprice/db/utils"
import { formatMoney } from "@unprice/money"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import type { ChartConfig } from "@unprice/ui/chart"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { BarChart3, CalendarRange, Coins, Layers3, TriangleAlert, Users } from "lucide-react"
import dynamic from "next/dynamic"
import { useParams } from "next/navigation"
import { NumberTicker } from "~/components/analytics/number-ticker"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { SuperLink } from "~/components/super-link"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

const UsageAreaChart = dynamic(
  () => import("./usage-area-chart").then((mod) => ({ default: mod.UsageAreaChart })),
  { ssr: false, loading: () => <Skeleton className="h-[200px] w-full rounded-md" /> }
)

const TIMESERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

type TimeseriesPoint = {
  date: number
  dateLabel: string
  [feature: string]: string | number
}

function buildTimeseriesData(
  rows: { date: number; feature_slug: string; usage?: number }[],
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

  // Fill missing feature values with 0
  for (const point of data) {
    for (const feature of features) {
      if (!(feature in point)) {
        point[feature] = 0
      }
    }
  }

  return { data, features }
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

type UsageSpending = {
  amount: string
  currency: string
  display_amount: string
}

type UsageRowWithSpending = {
  feature_slug: string
  usage: number
  spending?: UsageSpending
}

type SpendingSummary = {
  currency: string
  amount: number
  displayAmount: string
}

function parseSpendingAmount(row: UsageRowWithSpending): number {
  const amount = Number(row.spending?.amount ?? 0)
  return Number.isFinite(amount) ? amount : 0
}

function roundToTwoDecimals(value: string): string {
  const num = Number.parseFloat(value)

  if (!Number.isFinite(num)) {
    return value
  }

  return num.toFixed(2)
}

function summarizeSpending(rows: UsageRowWithSpending[]): SpendingSummary[] {
  const totalsByCurrency = new Map<string, number>()

  for (const row of rows) {
    const currency = row.spending?.currency

    if (!currency) {
      continue
    }

    totalsByCurrency.set(currency, (totalsByCurrency.get(currency) ?? 0) + parseSpendingAmount(row))
  }

  return [...totalsByCurrency.entries()].map(([currency, amount]) => ({
    currency,
    amount,
    displayAmount: formatMoney(roundToTwoDecimals(amount.toString()), currency),
  }))
}

function formatSpendingSummary(summary: SpendingSummary[]): string {
  if (summary.length === 0) {
    return "No spend"
  }

  return summary.map((item) => item.displayAmount).join(" + ")
}

function formatFeatureSpending(row: UsageRowWithSpending): string {
  if (!row.spending) {
    return "No spend"
  }

  return formatMoney(roundToTwoDecimals(row.spending.amount), row.spending.currency)
}

export function UsageStatsSkeleton() {
  return (
    <Card className="overflow-hidden border-muted/60">
      <CardHeader>
        <CardTitle>Usage Dashboard</CardTitle>
        <CardDescription>Loading usage metrics for this project...</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-4 pb-6">
        <div className="grid gap-3 md:grid-cols-4">
          {["features", "total", "spend", "interval"].map((item) => (
            <Card key={`usage-metric-skeleton-${item}`} className="border-muted/60">
              <CardContent className="space-y-2 px-4 py-3">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-8 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="overflow-hidden rounded-md border border-border/60">
          <Skeleton className="h-[420px] w-full" />
        </div>
      </CardContent>
    </Card>
  )
}

function UsageStatsErrorState({ error }: { error: string }) {
  return (
    <Card className="border-muted/60">
      <CardHeader>
        <CardTitle>Usage Dashboard</CardTitle>
        <CardDescription>Usage analytics could not be loaded right now.</CardDescription>
      </CardHeader>
      <CardContent className="pt-4 pb-6">
        <EmptyPlaceholder className="min-h-[420px]">
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

function UsageStatsEmptyState({ intervalLabel }: { intervalLabel: string }) {
  return (
    <Card className="border-muted/60">
      <CardHeader>
        <CardTitle>Usage Dashboard</CardTitle>
        <CardDescription>Feature usage for this project in the {intervalLabel}.</CardDescription>
      </CardHeader>
      <CardContent className="py-4">
        <EmptyPlaceholder className="min-h-[420px] transition-opacity duration-300">
          <EmptyPlaceholder.Icon>
            <BarChart3 className="h-8 w-8 opacity-40 motion-safe:animate-pulse" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>No usage data yet</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            Usage appears here once your project reports feature consumption.
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

export function UsageStats() {
  const [intervalFilter] = useIntervalFilter()
  const trpc = useTRPC()
  const params = useParams<{ workspaceSlug: string; projectSlug: string }>()
  const isNearRealtime = intervalFilter.intervalDays === 1

  const {
    data: usage,
    dataUpdatedAt: usageUpdatedAt,
    isFetching: isUsageFetching,
  } = useSuspenseQuery(
    trpc.analytics.getProjectUsage.queryOptions(
      {
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

  const { data: timeseriesData } = useSuspenseQuery(
    trpc.analytics.getProjectUsageTimeseries.queryOptions(
      {
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

  const { data: topConsumersData } = useSuspenseQuery(
    trpc.analytics.getTopConsumers.queryOptions(
      {
        range: intervalFilter.name,
        limit: 10,
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
    dataUpdatedAt: usageUpdatedAt,
    isFetching: isUsageFetching,
    getQueryKey: (param) => [
      ["analytics", "getProjectUsage"],
      {
        input: {
          range: param,
        },
        type: "query",
      },
    ],
  })

  useQueryInvalidation({
    paramKey: intervalFilter.name,
    dataUpdatedAt: usageUpdatedAt,
    isFetching: isUsageFetching,
    getQueryKey: (param) => [
      ["analytics", "getProjectUsageTimeseries"],
      {
        input: {
          range: param,
        },
        type: "query",
      },
    ],
  })

  useQueryInvalidation({
    paramKey: intervalFilter.name,
    dataUpdatedAt: usageUpdatedAt,
    isFetching: isUsageFetching,
    getQueryKey: (param) => [
      ["analytics", "getTopConsumers"],
      {
        input: {
          range: param,
          limit: 10,
        },
        type: "query",
      },
    ],
  })

  if (usage.error) {
    return <UsageStatsErrorState error={usage.error} />
  }

  const sortedUsage = [...(usage.usage ?? [])].sort((a, b) => {
    if (b.usage !== a.usage) {
      return b.usage - a.usage
    }

    return a.feature_slug.localeCompare(b.feature_slug)
  })

  if (sortedUsage.length === 0) {
    return <UsageStatsEmptyState intervalLabel={intervalFilter.label} />
  }

  const totalLatestUsage = sortedUsage.reduce((sum, row) => sum + row.usage, 0)
  const spendingSummary = summarizeSpending(sortedUsage)
  const consumedAmountLabel = formatSpendingSummary(spendingSummary)
  const maxFeatureUsage = sortedUsage[0]?.usage ?? 1

  const { data: timeseriesChartData, features: timeseriesFeatures } = buildTimeseriesData(
    timeseriesData.timeseries ?? [],
    intervalFilter.dateFormat
  )
  const timeseriesConfig = Object.fromEntries(
    timeseriesFeatures.map((feature, i) => [
      feature,
      { label: feature, color: TIMESERIES_COLORS[i % TIMESERIES_COLORS.length] },
    ])
  ) satisfies ChartConfig

  return (
    <Card className="overflow-hidden border-muted/60">
      <div
        suppressHydrationWarning
        className={cn(
          "pointer-events-none h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent transition-opacity duration-300",
          isUsageFetching ? "opacity-100" : "opacity-0"
        )}
      />
      <CardHeader>
        <CardTitle>Usage Dashboard</CardTitle>
        <CardDescription>
          Usage in the {intervalFilter.label} for the currently selected project.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pb-6">
        <div className="grid gap-3 md:grid-cols-4">
          <Card className="overflow-hidden border-muted/60 bg-gradient-to-br from-background to-muted/20">
            <CardContent className="px-4 py-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-muted-foreground text-xs">Features with usage</p>
                <Layers3 className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="font-semibold text-xl">
                <NumberTicker value={sortedUsage.length} />
              </p>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-muted/60 bg-gradient-to-br from-background to-muted/20">
            <CardContent className="px-4 py-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-muted-foreground text-xs">Total latest usage</p>
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="font-semibold text-xl">
                <NumberTicker value={totalLatestUsage} withFormatter={true} />
              </p>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-muted/60 bg-gradient-to-br from-background to-muted/20">
            <CardContent className="px-4 py-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-muted-foreground text-xs">Consumed amount</p>
                <Coins className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="truncate font-semibold text-xl">{consumedAmountLabel}</p>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-muted/60 bg-gradient-to-br from-background to-muted/20">
            <CardContent className="px-4 py-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-muted-foreground text-xs">Selected interval</p>
                <CalendarRange className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="font-semibold text-base capitalize">{intervalFilter.label}</p>
            </CardContent>
          </Card>
        </div>

        {timeseriesChartData.length > 0 && (
          <UsageAreaChart
            data={timeseriesChartData}
            features={timeseriesFeatures}
            config={timeseriesConfig}
          />
        )}

        <div className="overflow-hidden rounded-md border border-border/60">
          <div className="grid grid-cols-[minmax(0,1fr)_6rem_7rem] items-center gap-4 bg-muted/40 px-4 py-2.5">
            <p className="text-muted-foreground text-xs uppercase">Feature</p>
            <p className="text-right text-muted-foreground text-xs uppercase">Usage</p>
            <p className="text-right text-muted-foreground text-xs uppercase">Consumed</p>
          </div>

          <div className="divide-y divide-border">
            {sortedUsage.map((row) => {
              const usagePercent = maxFeatureUsage > 0 ? (row.usage / maxFeatureUsage) * 100 : 0

              return (
                <div
                  key={row.feature_slug}
                  className="grid grid-cols-[minmax(0,1fr)_6rem_7rem] items-center gap-4 px-4 py-3"
                >
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium text-sm">{row.feature_slug}</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                      <div
                        className="h-full rounded-full bg-primary/60 transition-all"
                        style={{ width: `${usagePercent}%` }}
                      />
                    </div>
                  </div>
                  <span className="text-right font-mono text-muted-foreground text-sm tabular-nums">
                    {nFormatter(row.usage)}
                  </span>
                  <span className="text-right font-mono text-sm tabular-nums">
                    {formatFeatureSpending(row)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {topConsumersData.consumers.length > 0 && (
          <div className="overflow-hidden rounded-md border border-border/60">
            <div className="grid grid-cols-[auto_minmax(0,1fr)_6rem_7rem] items-center gap-3 bg-muted/40 px-4 py-2.5">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-muted-foreground text-xs uppercase">Top consumers</p>
              <p className="text-right text-muted-foreground text-xs uppercase">Usage</p>
              <p className="text-right text-muted-foreground text-xs uppercase">Consumed</p>
            </div>

            <div className="divide-y divide-border">
              {topConsumersData.consumers.map((consumer, index) => (
                <SuperLink
                  key={consumer.customerId}
                  href={`/${params.workspaceSlug}/${params.projectSlug}/customers/${consumer.customerId}`}
                  className="grid grid-cols-[auto_minmax(0,1fr)_6rem_7rem] items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30"
                >
                  <span className="font-mono text-muted-foreground text-xs tabular-nums">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-sm">{consumer.name}</p>
                    <p className="truncate text-muted-foreground text-xs">{consumer.email}</p>
                  </div>
                  <span className="text-right font-mono text-muted-foreground text-sm tabular-nums">
                    {nFormatter(consumer.totalUsage)}
                  </span>
                  <span className="text-right font-mono text-sm tabular-nums">
                    {consumer.displaySpending}
                  </span>
                </SuperLink>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
