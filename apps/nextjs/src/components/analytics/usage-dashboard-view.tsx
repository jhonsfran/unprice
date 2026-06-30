"use client"

import { nFormatter } from "@unprice/db/utils"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { BarChart3, Coins, Layers3, ReceiptText, TriangleAlert, Users } from "lucide-react"
import dynamic from "next/dynamic"
import { useMemo } from "react"
import { EvidenceMetricStrip, EvidenceMetricTile } from "~/components/analytics/evidence-panel"
import { FreshnessIndicator } from "~/components/analytics/freshness-indicator"
import { IntervalFilter } from "~/components/analytics/interval-filter"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { SuperLink } from "~/components/super-link"
import { ProgressBar } from "./progress"
import { type UsageChartPoint, buildUsageChartConfig } from "./usage-chart-config"

const UsageAreaChart = dynamic(
  () => import("./usage-area-chart").then((m) => ({ default: m.UsageAreaChart })),
  {
    ssr: false,
    loading: () => (
      <div className="overflow-hidden rounded-md border border-border/60 p-3 sm:p-4">
        <Skeleton className="mb-3 h-3 w-24" />
        <Skeleton className="h-[220px] w-full rounded-md" />
      </div>
    ),
  }
)

type UsageDashboardData = RouterOutputs["analytics"]["getUsageDashboard"]
type UsageDashboardFeature = UsageDashboardData["features"][number]

export function UsageDashboardSkeleton() {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-5 w-52" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-4 w-48" />
      </div>
      <Skeleton className="h-[252px] w-full rounded-lg border border-border/60" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-[190px] w-full rounded-lg border border-border/60" />
        <Skeleton className="h-[320px] w-full rounded-lg border border-border/60" />
      </div>
    </section>
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
  showCustomerSummary = mode === "customer",
  showHeaderControls = true,
}: {
  data: UsageDashboardData
  intervalLabel: string
  dateFormat: string
  mode: "project" | "customer"
  isFetching: boolean
  invoiceCount?: number
  customerHref?: (customerId: string) => string
  showCustomerSummary?: boolean
  showHeaderControls?: boolean
}) {
  // Hooks must be called unconditionally (before any early return)
  const chart = useMemo(
    () => buildChartData(data.timeseries, dateFormat),
    [data.timeseries, dateFormat]
  )
  const chartConfig = useMemo(() => buildUsageChartConfig(chart.features), [chart.features])

  if (data.error) {
    return <UsageDashboardErrorState error={data.error} />
  }

  if (data.features.length === 0 && data.timeseries.length === 0) {
    return (
      <UsageDashboardEmptyState
        intervalLabel={intervalLabel}
        mode={mode}
        generatedAt={data.freshness.generatedAt}
        isFetching={isFetching}
        showHeaderControls={showHeaderControls}
      />
    )
  }

  const maxFeatureUsage = data.features[0]?.usage ?? 1
  const featureLog = (
    <UsageFeatureTable
      features={data.features}
      maxFeatureUsage={maxFeatureUsage}
      featureCount={data.summary.featureCount}
      totalLatestUsage={data.summary.totalLatestUsage}
      spending={data.summary.spending}
      showSummaryStats={mode === "project" || showCustomerSummary}
    />
  )
  const topConsumers =
    mode === "project" && data.topConsumers.length > 0 && customerHref ? (
      <TopConsumersTable consumers={data.topConsumers} customerHref={customerHref} />
    ) : null

  return (
    <section className="relative flex flex-col gap-4">
      <div
        className={cn(
          "-top-2 pointer-events-none absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent transition-opacity duration-300",
          isFetching ? "opacity-100" : "opacity-0"
        )}
      />
      <UsageEvidenceHeader
        generatedAt={data.freshness.generatedAt}
        intervalLabel={intervalLabel}
        isFetching={isFetching}
        mode={mode}
        showControls={showHeaderControls}
      />
      <div
        className={cn(
          "flex flex-col gap-6 transition-opacity duration-300 motion-reduce:transition-none",
          isFetching ? "opacity-90" : "opacity-100"
        )}
      >
        {mode === "customer" && showCustomerSummary && (
          <EvidenceMetricStrip className="md:grid-cols-4">
            <EvidenceMetricTile
              label="Features reporting"
              icon={<Layers3 className="h-4 w-4 text-muted-foreground" />}
              value={String(data.summary.featureCount)}
              helper="Feature slugs with usage in this interval"
            />
            <EvidenceMetricTile
              label="Latest usage total"
              icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
              value={nFormatter(data.summary.totalLatestUsage, { digits: 1 })}
              helper="Latest cumulative usage across reporting features"
            />
            <EvidenceMetricTile
              label="Ledger consumed"
              icon={<Coins className="h-4 w-4 text-muted-foreground" />}
              value={formatSpendingSummary(data.summary.spending)}
              helper="Display amount from ledger-scale usage spend"
              valueClassName="truncate text-xl"
            />
            <EvidenceMetricTile
              label="Invoices"
              icon={<ReceiptText className="h-4 w-4 text-muted-foreground" />}
              value={String(invoiceCount ?? 0)}
              helper="Invoices connected to this customer"
            />
          </EvidenceMetricStrip>
        )}

        {chart.data.length > 0 && (
          <UsageAreaChart
            data={chart.data}
            features={chart.features}
            config={chartConfig}
            heightClassName={mode === "customer" ? "h-[240px]" : "h-[220px]"}
          />
        )}

        {topConsumers ? (
          <div className="grid items-start gap-4 xl:grid-cols-2">
            {featureLog}
            {topConsumers}
          </div>
        ) : (
          featureLog
        )}
      </div>
    </section>
  )
}

function UsageEvidenceHeader({
  intervalLabel,
  mode,
  generatedAt,
  isFetching,
  showControls,
}: {
  intervalLabel: string
  mode: "project" | "customer"
  generatedAt: number
  isFetching: boolean
  showControls: boolean
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 space-y-1.5">
        <h2 className="font-semibold text-lg leading-none">
          {mode === "customer" ? "Customer usage evidence" : "Usage and spend evidence"}
        </h2>
        <p className="text-muted-foreground text-sm">
          Latest feature usage and ledger display amounts for this{" "}
          {mode === "customer" ? "customer" : "project"} in the {intervalLabel}.
        </p>
      </div>
      {showControls && (
        <div className="flex shrink-0 flex-col items-start gap-4 md:items-end">
          {mode === "customer" && <IntervalFilter />}
          <FreshnessIndicator
            generatedAt={generatedAt}
            isFetching={isFetching}
            className="md:justify-end"
          />
        </div>
      )}
    </div>
  )
}

function UsageFeatureTable({
  features,
  maxFeatureUsage,
  featureCount,
  totalLatestUsage,
  spending,
  showSummaryStats,
}: {
  features: UsageDashboardFeature[]
  maxFeatureUsage: number
  featureCount: number
  totalLatestUsage: number
  spending: UsageDashboardData["summary"]["spending"]
  showSummaryStats: boolean
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      <div className="flex flex-col gap-3 border-border/60 border-b bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <BarChart3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="font-medium text-sm">Feature log</p>
            <p className="text-muted-foreground text-xs">
              {featureCount} {featureCount === 1 ? "feature slug" : "feature slugs"} reporting in
              this interval
            </p>
          </div>
        </div>
        {showSummaryStats && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <UsageEvidenceStat
              label="Total usage"
              value={nFormatter(totalLatestUsage, { digits: 1 })}
            />
            <UsageEvidenceStat label="Ledger used" value={formatSpendingSummary(spending)} />
          </div>
        )}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_6rem_7rem] items-center gap-4 bg-muted/40 px-4 py-2.5">
        <p className="text-muted-foreground text-xs uppercase">Feature slug</p>
        <p className="text-right text-muted-foreground text-xs uppercase">Latest usage</p>
        <p className="text-right text-muted-foreground text-xs uppercase">Ledger used</p>
      </div>
      <div className="divide-y divide-border">
        {features.map((feature) => {
          return (
            <div
              key={feature.featureSlug}
              className="grid grid-cols-[minmax(0,1fr)_6rem_7rem] items-center gap-4 px-4 py-3"
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate font-medium text-sm">{feature.featureSlug}</span>
                </div>
                <ProgressBar value={feature.usage} max={maxFeatureUsage} className="h-1.5 w-full" />
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

function UsageEvidenceStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5 rounded-md bg-muted/50 px-2 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[11rem] truncate font-mono text-foreground tabular-nums">{value}</span>
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
      <div className="border-border/60 border-b bg-card px-4 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="font-medium text-sm">Top customers</p>
            <p className="text-muted-foreground text-xs">Ranked by ledger spend</p>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_6rem_7rem] items-center gap-3 bg-muted/40 px-4 py-2.5">
        <p className="text-muted-foreground text-xs uppercase">#</p>
        <p className="text-muted-foreground text-xs uppercase">Customer</p>
        <p className="text-right text-muted-foreground text-xs uppercase">Usage</p>
        <p className="text-right text-muted-foreground text-xs uppercase">Ledger used</p>
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
        <CardTitle>Usage evidence</CardTitle>
        <CardDescription>Usage and ledger display amounts could not be loaded.</CardDescription>
      </CardHeader>
      <CardContent className="pt-4 pb-6">
        <EmptyPlaceholder className="min-h-[220px]">
          <EmptyPlaceholder.Icon>
            <TriangleAlert className="h-8 w-8 opacity-60" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>Unable to load usage evidence</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>{error}</EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

function UsageDashboardEmptyState({
  intervalLabel,
  mode,
  generatedAt,
  isFetching,
  showHeaderControls,
}: {
  intervalLabel: string
  mode: "project" | "customer"
  generatedAt: number
  isFetching: boolean
  showHeaderControls: boolean
}) {
  return (
    <section className="flex flex-col gap-4">
      <UsageEvidenceHeader
        generatedAt={generatedAt}
        intervalLabel={intervalLabel}
        isFetching={isFetching}
        mode={mode}
        showControls={showHeaderControls}
      />
      <Card className="border-muted/60">
        <CardContent className="py-6">
          <EmptyPlaceholder className="min-h-[520px] transition-opacity duration-300">
            <EmptyPlaceholder.Icon>
              <BarChart3 className="h-8 w-8 text-primary motion-safe:animate-pulse" />
            </EmptyPlaceholder.Icon>
            <EmptyPlaceholder.Title>No usage data yet</EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>
              Record usage events with feature slugs. Rejected or failed events appear in Events.
            </EmptyPlaceholder.Description>
          </EmptyPlaceholder>
        </CardContent>
      </Card>
    </section>
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

  const data = Array.from(pointsByDate.values())
  data.sort((a, b) => a.date - b.date)

  const features = Array.from(featureSet)
  features.sort()

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

function formatSpendingSummary(summary: UsageDashboardData["summary"]["spending"]): string {
  if (summary.length === 0) {
    return "No spend"
  }

  return summary.map((item) => item.displayAmount).join(" + ")
}
