"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { nFormatter } from "@unprice/db/utils"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { BarChart3, CalendarRange, Coins, Layers3, TriangleAlert } from "lucide-react"
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts"
import { NumberTicker } from "~/components/analytics/number-ticker"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

const usageChartConfig = {
  usage: { label: "Usage", color: "var(--chart-4)" },
} satisfies ChartConfig

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

// Local browser-locale formatter for summed numeric amounts in client components.
// Differs from @unprice/money's formatMoney which formats string amounts server-side.
function formatCurrencyAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
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
    displayAmount: formatCurrencyAmount(amount, currency),
  }))
}

function formatSpendingSummary(summary: SpendingSummary[]): string {
  if (summary.length === 0) {
    return "No spend"
  }

  return summary.map((item) => item.displayAmount).join(" + ")
}

function formatFeatureSpending(row: UsageRowWithSpending): string {
  return row.spending?.display_amount ?? "No spend"
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
        staleTime: isNearRealtime ? 45 * 1000 : 5 * 60 * 1000,
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
  const chartData = sortedUsage.map((row) => ({
    feature: row.feature_slug,
    usage: row.usage,
    spending: formatFeatureSpending(row),
  }))
  const chartHeight = Math.min(Math.max(chartData.length * 52, 280), 560)

  return (
    <Card className="overflow-hidden border-muted/60">
      <div
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

        <div className="overflow-hidden rounded-md border border-border/60 p-3 sm:p-4">
          <ChartContainer
            config={usageChartConfig}
            className="w-full"
            style={{ height: `${chartHeight}px` }}
          >
            <BarChart
              accessibilityLayer
              data={chartData}
              layout="vertical"
              margin={{
                left: 8,
                right: 44,
                top: 6,
                bottom: 6,
              }}
              barCategoryGap="24%"
            >
              <CartesianGrid horizontal={false} className="stroke-muted" />
              <YAxis
                dataKey="feature"
                type="category"
                width={160}
                axisLine={false}
                tickLine={false}
                tickMargin={10}
                tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                tickFormatter={(value: string) =>
                  value.length > 20 ? `${value.slice(0, 20)}...` : value
                }
              />
              <XAxis
                dataKey="usage"
                type="number"
                axisLine={false}
                tickLine={false}
                tickMargin={10}
                tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                tickFormatter={(value) => nFormatter(Number(value))}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    formatter={(value, name) => {
                      if (typeof value !== "number") {
                        return value
                      }

                      return (
                        <>
                          <span>{String(name)}</span>
                          <span className="ml-auto font-medium font-mono text-foreground tabular-nums">
                            {nFormatter(value)}
                          </span>
                        </>
                      )
                    }}
                  />
                }
              />
              <Bar dataKey="usage" radius={[0, 8, 8, 0]} fill="var(--color-usage)" maxBarSize={30}>
                <LabelList
                  dataKey="usage"
                  position="right"
                  offset={8}
                  className="fill-foreground font-mono text-xs"
                  formatter={(value: number) => nFormatter(value)}
                />
              </Bar>
            </BarChart>
          </ChartContainer>
        </div>

        <div className="overflow-hidden rounded-md border border-border/60">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 bg-muted/40 px-4 py-2.5">
            <p className="text-muted-foreground text-xs uppercase">Feature</p>
            <p className="text-right text-muted-foreground text-xs uppercase">Usage</p>
            <p className="text-right text-muted-foreground text-xs uppercase">Consumed</p>
          </div>

          <div className="divide-y divide-border">
            {chartData.map((row) => (
              <div
                key={row.feature}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium text-sm">{row.feature}</span>
                </div>
                <span className="font-mono text-muted-foreground text-sm tabular-nums">
                  {nFormatter(row.usage)}
                </span>
                <span className="font-mono text-sm tabular-nums">{row.spending}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
