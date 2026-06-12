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
import { BarChart3, CalendarRange, Coins, Layers3, TriangleAlert } from "lucide-react"
import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

type CustomerMetricsPanelProps = {
  customerId: string
}

type UsageRow = RouterOutputs["analytics"]["getProjectUsage"]["usage"][number]

type SpendingSummary = {
  currency: string
  displayAmount: string
}

const chartConfig = {
  usage: {
    label: "Usage",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig

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
    displayAmount: formatMoney(amount.toString(), currency),
  }))
}

function formatSpendingSummary(summary: SpendingSummary[]): string {
  if (summary.length === 0) {
    return "No spend"
  }

  return summary.map((item) => item.displayAmount).join(" + ")
}

function formatFeatureSpending(row: UsageRow): string {
  return row.spending.display_amount
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
          {["features", "usage", "spend", "interval"].map((item) => (
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
      <CardHeader>
        <CardTitle>Customer usage</CardTitle>
        <CardDescription>Usage analytics could not be loaded right now.</CardDescription>
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
      <CardHeader>
        <CardTitle>Customer usage</CardTitle>
        <CardDescription>Usage for this customer in the {intervalLabel}.</CardDescription>
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

export function CustomerMetricsPanel({ customerId }: CustomerMetricsPanelProps) {
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

  if (usage.error) {
    return <CustomerMetricsErrorState error={usage.error} />
  }

  const sortedUsage = [...usage.usage].sort((a, b) => {
    if (b.usage !== a.usage) {
      return b.usage - a.usage
    }

    return a.feature_slug.localeCompare(b.feature_slug)
  })

  if (sortedUsage.length === 0) {
    return <CustomerMetricsEmptyState intervalLabel={intervalFilter.label} />
  }

  const totalLatestUsage = sortedUsage.reduce((sum, row) => sum + row.usage, 0)
  const spendingSummary = summarizeSpending(sortedUsage)
  const consumedAmountLabel = formatSpendingSummary(spendingSummary)
  const chartData = sortedUsage.map((row) => ({
    feature: row.feature_slug,
    usage: row.usage,
    fill: "var(--color-usage)",
  }))
  const chartHeight = Math.max(220, Math.min(chartData.length * 58, 420))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer usage</CardTitle>
        <CardDescription>Usage for this customer in the {intervalFilter.label}.</CardDescription>
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
              <p className="text-muted-foreground text-sm">Selected interval</p>
              <CalendarRange className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="mt-1 font-semibold text-foreground text-xl capitalize">
              {intervalFilter.label}
            </p>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-border p-4">
          <p className="mb-3 text-muted-foreground text-xs uppercase">Usage by feature</p>
          <ChartContainer config={chartConfig} height={chartHeight} className="w-full">
            <BarChart
              accessibilityLayer
              data={chartData}
              layout="vertical"
              margin={{ left: 8, right: 42, top: 8, bottom: 8 }}
            >
              <XAxis type="number" hide />
              <YAxis
                dataKey="feature"
                type="category"
                axisLine={false}
                tickLine={false}
                tickMargin={10}
                width={120}
                tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
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
              <Bar dataKey="usage" radius={4} fill="var(--color-usage)" maxBarSize={28}>
                <LabelList
                  dataKey="usage"
                  position="right"
                  offset={8}
                  className="fill-foreground font-mono text-xs"
                  formatter={(value: number) => formatUsage(value)}
                />
              </Bar>
            </BarChart>
          </ChartContainer>
        </div>

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
