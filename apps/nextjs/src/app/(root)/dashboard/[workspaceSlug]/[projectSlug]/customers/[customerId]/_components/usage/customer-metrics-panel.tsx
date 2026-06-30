"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { nFormatter } from "@unprice/db/utils"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { BarChart3, Coins, FileText, Gauge } from "lucide-react"
import type { ReactNode } from "react"
import { FreshnessIndicator } from "~/components/analytics/freshness-indicator"
import { IntervalFilter } from "~/components/analytics/interval-filter"
import {
  UsageDashboardSkeleton,
  UsageDashboardView,
} from "~/components/analytics/usage-dashboard-view"
import { SuperLink } from "~/components/super-link"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

type CustomerMetricsPanelProps = {
  customerId: string
}
type EconomicSummary = RouterOutputs["customers"]["getEconomicSummary"]
type UsageDashboardData = RouterOutputs["analytics"]["getUsageDashboard"]

export { UsageDashboardSkeleton as CustomerMetricsPanelSkeleton }

export function CustomerEvidenceSummarySkeleton() {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-[32rem] max-w-full" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {CUSTOMER_EVIDENCE_SKELETONS.map((metric) => (
          <Skeleton key={metric} className="h-[128px] rounded-lg border border-border/60" />
        ))}
      </div>
    </section>
  )
}

export function CustomerEvidenceSummary({
  customerId,
  baseUrl,
  runCounts,
  invoiceCounts,
}: {
  customerId: string
  baseUrl: string
  runCounts: EconomicSummary["runCounts"]
  invoiceCounts: EconomicSummary["invoiceCounts"]
}) {
  const [intervalFilter] = useIntervalFilter()
  const trpc = useTRPC()
  const queryInput = {
    customerId,
    range: intervalFilter.name,
  }
  const { data, isFetching } = useSuspenseQuery(
    trpc.analytics.getUsageDashboard.queryOptions(queryInput, {
      ...ANALYTICS_CONFIG_REALTIME,
      placeholderData: (previousData) => previousData,
    })
  )

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1.5">
          <h2 className="font-semibold text-lg leading-none">Customer evidence</h2>
          <p className="text-muted-foreground text-sm">
            Usage and ledger follow {intervalFilter.label}; runs and invoices are current totals.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-3 md:items-end">
          <IntervalFilter />
          <FreshnessIndicator
            generatedAt={data.freshness.generatedAt}
            isFetching={isFetching}
            className="md:justify-end"
          />
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <EvidenceCard
          icon={<BarChart3 className="size-4" />}
          title="Usage total"
          primary={nFormatter(data.summary.totalLatestUsage, { digits: 1 })}
          secondary={`Latest in ${intervalFilter.label}`}
        />
        <EvidenceCard
          icon={<Coins className="size-4" />}
          title="Ledger consumed"
          primary={formatSpendingSummary(data.summary.spending)}
          secondary={`Usage ledger in ${intervalFilter.label}`}
          truncate
        />
        <EvidenceCard
          href={`${baseUrl}/runs`}
          icon={<Gauge className="size-4" />}
          title="Runs"
          primary={`${runCounts.total} total`}
          secondary={`${runCounts.running} running / ${runCounts.budgetExceeded} budget exceeded`}
        />
        <EvidenceCard
          href={`${baseUrl}/invoices`}
          icon={<FileText className="size-4" />}
          title="Invoices"
          primary={`${invoiceCounts.total} total`}
          secondary={`${invoiceCounts.paid} paid`}
        />
      </div>
    </section>
  )
}

export function CustomerMetricsPanel({ customerId }: CustomerMetricsPanelProps) {
  const [intervalFilter] = useIntervalFilter()
  const trpc = useTRPC()
  const queryInput = {
    customerId,
    range: intervalFilter.name,
  }

  const { data, dataUpdatedAt, isFetching } = useSuspenseQuery(
    trpc.analytics.getUsageDashboard.queryOptions(queryInput, {
      ...ANALYTICS_CONFIG_REALTIME,
      placeholderData: (previousData) => previousData,
    })
  )

  useQueryInvalidation({
    paramKey: intervalFilter.name,
    dataUpdatedAt,
    isFetching,
    getQueryKey: (param) => [
      ["analytics", "getUsageDashboard"],
      {
        input: {
          customerId,
          range: param,
        },
        type: "query",
      },
    ],
  })

  return (
    <UsageDashboardView
      data={data}
      intervalLabel={intervalFilter.label}
      dateFormat={intervalFilter.dateFormat}
      mode="customer"
      isFetching={isFetching}
      showCustomerSummary={false}
      showHeaderControls={false}
    />
  )
}

const CUSTOMER_EVIDENCE_SKELETONS = ["usage", "ledger", "runs", "invoices"]

function EvidenceCard({
  href,
  icon,
  title,
  primary,
  secondary,
  truncate = false,
}: {
  href?: string
  icon: ReactNode
  title: string
  primary: string
  secondary: string
  truncate?: boolean
}) {
  const card = (
    <Card
      className={cn(
        "h-full border-muted/60",
        href && "transition-colors hover:border-primary/50 motion-reduce:transition-none"
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="font-medium text-sm">{title}</CardTitle>
        <span className="text-muted-foreground">{icon}</span>
      </CardHeader>
      <CardContent>
        <p className={truncate ? "truncate font-semibold text-lg" : "font-semibold text-lg"}>
          {primary}
        </p>
        <p className="mt-1 truncate text-muted-foreground text-xs">{secondary}</p>
      </CardContent>
    </Card>
  )

  if (!href) {
    return card
  }

  return (
    <SuperLink href={href} className="block">
      {card}
    </SuperLink>
  )
}

function formatSpendingSummary(summary: UsageDashboardData["summary"]["spending"]): string {
  if (summary.length === 0) {
    return "No spend"
  }

  return summary.map((item) => item.displayAmount).join(" + ")
}
