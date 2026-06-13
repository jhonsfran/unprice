"use client"

import { nFormatter } from "@unprice/db/utils"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { BarChart3, CalendarRange, Coins, Layers3, ReceiptText, TriangleAlert, Users } from "lucide-react"
import type { ReactNode } from "react"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { SuperLink } from "~/components/super-link"
import {
  type UsageChartPoint,
  UsageAreaChart,
  buildUsageChartConfig,
} from "./usage-area-chart"

type UsageDashboardData = RouterOutputs["analytics"]["getUsageDashboard"]
type UsageDashboardFeature = UsageDashboardData["features"][number]

export function UsageDashboardSkeleton() {
  return (
    <Card className="overflow-hidden border-muted/60">
      <CardHeader>
        <CardTitle>Usage Dashboard</CardTitle>
        <CardDescription>Loading usage metrics...</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-4 pb-6">
        <div className="grid gap-3 md:grid-cols-4">
          {["features", "usage", "spend", "context"].map((item) => (
            <div key={`usage-dashboard-skeleton-${item}`} className="rounded-lg border p-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-3 h-8 w-20" />
            </div>
          ))}
        </div>
        <Skeleton className="h-[220px] w-full rounded-lg" />
        <Skeleton className="h-[160px] w-full rounded-lg" />
      </CardContent>
    </Card>
  )
}

export function UsageDashboardView({
  data,
  intervalLabel,
  dateFormat,
  mode,
  isFetching,
  invoiceCount,
  customerHref,
}: {
  data: UsageDashboardData
  intervalLabel: string
  dateFormat: string
  mode: "project" | "customer"
  isFetching: boolean
  invoiceCount?: number
  customerHref?: (customerId: string) => string
}) {
  if (data.error) {
    return <UsageDashboardErrorState error={data.error} />
  }

  if (data.features.length === 0 && data.timeseries.length === 0) {
    return <UsageDashboardEmptyState intervalLabel={intervalLabel} mode={mode} />
  }

  const chart = buildChartData(data.timeseries, dateFormat)
  const chartConfig = buildUsageChartConfig(chart.features)
  const maxFeatureUsage = data.features[0]?.usage ?? 1

  return (
    <Card className="overflow-hidden border-muted/60">
      <div
        className={cn(
          "pointer-events-none h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent transition-opacity duration-300",
          isFetching ? "opacity-100" : "opacity-0"
        )}
      />
      <CardHeader>
        <CardTitle>{mode === "customer" ? "Customer usage" : "Usage Dashboard"}</CardTitle>
        <CardDescription>
          Usage in the {intervalLabel}
          {mode === "project" ? " for the currently selected project." : "."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pb-6">
        <div className="grid gap-3 md:grid-cols-4">
          <MetricCard
            label="Features with usage"
            icon={<Layers3 className="h-4 w-4 text-muted-foreground" />}
            value={String(data.summary.featureCount)}
          />
          <MetricCard
            label="Total latest usage"
            icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
            value={nFormatter(data.summary.totalLatestUsage, { digits: 1 })}
          />
          <MetricCard
            label="Consumed amount"
            icon={<Coins className="h-4 w-4 text-muted-foreground" />}
            value={formatSpendingSummary(data.summary.spending)}
            truncate
          />
          {mode === "customer" ? (
            <MetricCard
              label="Number of invoices"
              icon={<ReceiptText className="h-4 w-4 text-muted-foreground" />}
              value={String(invoiceCount ?? 0)}
            />
          ) : (
            <MetricCard
              label="Selected interval"
              icon={<CalendarRange className="h-4 w-4 text-muted-foreground" />}
              value={intervalLabel}
              capitalize
            />
          )}
        </div>

        {chart.data.length > 0 && (
          <UsageAreaChart
            data={chart.data}
            features={chart.features}
            config={chartConfig}
            heightClassName={mode === "customer" ? "h-[240px]" : "h-[220px]"}
          />
        )}

        <UsageFeatureTable features={data.features} maxFeatureUsage={maxFeatureUsage} />

        {mode === "project" && data.topConsumers.length > 0 && customerHref && (
          <TopConsumersTable consumers={data.topConsumers} customerHref={customerHref} />
        )}
      </CardContent>
    </Card>
  )
}

function MetricCard({
  label,
  icon,
  value,
  truncate = false,
  capitalize = false,
}: {
  label: string
  icon: ReactNode
  value: string
  truncate?: boolean
  capitalize?: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">{label}</p>
        {icon}
      </div>
      <p
        className={cn(
          "mt-1 font-semibold text-2xl text-foreground",
          truncate && "truncate text-xl",
          capitalize && "text-base capitalize"
        )}
      >
        {value}
      </p>
    </div>
  )
}

function UsageFeatureTable({
  features,
  maxFeatureUsage,
}: {
  features: UsageDashboardFeature[]
  maxFeatureUsage: number
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      <div className="grid grid-cols-[minmax(0,1fr)_6rem_7rem] items-center gap-4 bg-muted/40 px-4 py-2.5">
        <p className="text-muted-foreground text-xs uppercase">Feature</p>
        <p className="text-right text-muted-foreground text-xs uppercase">Usage</p>
        <p className="text-right text-muted-foreground text-xs uppercase">Consumed</p>
      </div>
      <div className="divide-y divide-border">
        {features.map((feature) => {
          const usagePercent = maxFeatureUsage > 0 ? (feature.usage / maxFeatureUsage) * 100 : 0

          return (
            <div
              key={feature.featureSlug}
              className="grid grid-cols-[minmax(0,1fr)_6rem_7rem] items-center gap-4 px-4 py-3"
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium text-sm">{feature.featureSlug}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                  <div
                    className="h-full rounded-full bg-primary/60 transition-all"
                    style={{ width: `${usagePercent}%` }}
                  />
                </div>
              </div>
              <Badge variant="outline" className="justify-self-end font-mono text-xs tabular-nums">
                {nFormatter(feature.usage, { digits: 1 })}
              </Badge>
              <span className="truncate text-right font-mono text-sm tabular-nums">
                {feature.spending.displayAmount}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TopConsumersTable({
  consumers,
  customerHref,
}: {
  consumers: UsageDashboardData["topConsumers"]
  customerHref: (customerId: string) => string
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_6rem_7rem] items-center gap-3 bg-muted/40 px-4 py-2.5">
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-muted-foreground text-xs uppercase">Top consumers</p>
        <p className="text-right text-muted-foreground text-xs uppercase">Usage</p>
        <p className="text-right text-muted-foreground text-xs uppercase">Consumed</p>
      </div>
      <div className="divide-y divide-border">
        {consumers.map((consumer, index) => (
          <SuperLink
            key={consumer.customerId}
            href={customerHref(consumer.customerId)}
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
              {nFormatter(consumer.totalUsage, { digits: 1 })}
            </span>
            <span className="text-right font-mono text-sm tabular-nums">
              {consumer.displaySpending}
            </span>
          </SuperLink>
        ))}
      </div>
    </div>
  )
}

function UsageDashboardErrorState({ error }: { error: string }) {
  return (
    <Card className="border-muted/60">
      <CardHeader>
        <CardTitle>Usage Dashboard</CardTitle>
        <CardDescription>Usage analytics could not be loaded right now.</CardDescription>
      </CardHeader>
      <CardContent className="pt-4 pb-6">
        <EmptyPlaceholder className="min-h-[220px]">
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

function UsageDashboardEmptyState({
  intervalLabel,
  mode,
}: {
  intervalLabel: string
  mode: "project" | "customer"
}) {
  return (
    <Card className="border-muted/60">
      <CardHeader>
        <CardTitle>{mode === "customer" ? "Customer usage" : "Usage Dashboard"}</CardTitle>
        <CardDescription>Usage for the {intervalLabel}.</CardDescription>
      </CardHeader>
      <CardContent className="py-4">
        <EmptyPlaceholder className="min-h-[220px] transition-opacity duration-300">
          <EmptyPlaceholder.Icon>
            <BarChart3 className="h-8 w-8 opacity-40 motion-safe:animate-pulse" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>No usage data yet</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            Usage appears here once feature consumption is reported.
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

function buildChartData(
  rows: UsageDashboardData["timeseries"],
  dateFormat: string
): { data: UsageChartPoint[]; features: string[] } {
  const featureSet = new Set<string>()
  const pointsByDate = new Map<number, UsageChartPoint>()

  for (const row of rows) {
    featureSet.add(row.featureSlug)

    const point =
      pointsByDate.get(row.date) ??
      ({ date: row.date, dateLabel: formatDateLabel(row.date, dateFormat) } as UsageChartPoint)

    point[row.featureSlug] = row.usage
    pointsByDate.set(row.date, point)
  }

  return {
    data: [...pointsByDate.values()].sort((a, b) => a.date - b.date),
    features: [...featureSet].sort(),
  }
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

function formatSpendingSummary(summary: UsageDashboardData["summary"]["spending"]): string {
  if (summary.length === 0) {
    return "No spend"
  }

  return summary.map((item) => item.displayAmount).join(" + ")
}
