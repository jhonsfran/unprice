"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { nFormatter } from "@unprice/db/utils"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Skeleton } from "@unprice/ui/skeleton"
import { BarChart3, Coins, FileText, Gauge } from "lucide-react"
import { EvidenceMetricStrip, EvidenceMetricTile } from "~/components/analytics/evidence-panel"
import { FreshnessIndicator } from "~/components/analytics/freshness-indicator"
import { IntervalFilter } from "~/components/analytics/interval-filter"
import {
  UsageDashboardSkeleton,
  UsageDashboardView,
} from "~/components/analytics/usage-dashboard-view"
import type { SDKExampleParams } from "~/components/landing/sdk-examples"
import { SectionIntro } from "~/components/layout/section-intro"
import { SuperLink } from "~/components/super-link"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

type CustomerMetricsPanelProps = {
  customerId: string
  currentAccess: RouterOutputs["customers"]["getCurrentAccess"]
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
      <EvidenceMetricStrip className="sm:grid-cols-2 xl:grid-cols-4">
        {CUSTOMER_EVIDENCE_SKELETONS.map((metric) => (
          <Skeleton key={metric} className="h-[104px] rounded-none" />
        ))}
      </EvidenceMetricStrip>
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
    <section className="flex flex-col gap-6">
      <SectionIntro
        title="Customer evidence"
        description={`Usage and ledger follow ${intervalFilter.label}; runs and invoices are current totals.`}
        className="px-0 py-0"
        actions={
          <div className="flex flex-col items-start gap-8 md:items-end">
            <IntervalFilter />
            <FreshnessIndicator
              generatedAt={data.freshness.generatedAt}
              isFetching={isFetching}
              className="md:justify-end"
            />
          </div>
        }
      />
      <EvidenceMetricStrip className="sm:grid-cols-2 xl:grid-cols-4">
        <EvidenceMetricTile
          icon={<BarChart3 className="size-4" />}
          label="Usage total"
          value={nFormatter(data.summary.totalLatestUsage, { digits: 1 })}
          helper={`Latest in ${intervalFilter.label}`}
        />
        <EvidenceMetricTile
          icon={<Coins className="size-4" />}
          label="Ledger consumed"
          value={formatSpendingSummary(data.summary.spending)}
          helper={`Usage ledger in ${intervalFilter.label}`}
          valueClassName="truncate"
        />
        <SuperLink href={`${baseUrl}/runs`} className="block h-full">
          <EvidenceMetricTile
            className="h-full transition-colors hover:bg-card motion-reduce:transition-none"
            icon={<Gauge className="size-4" />}
            label="Runs"
            value={`${runCounts.total} total`}
            helper={`${runCounts.running} running / ${runCounts.budgetExceeded} budget exceeded`}
          />
        </SuperLink>
        <SuperLink href={`${baseUrl}/invoices`} className="block h-full">
          <EvidenceMetricTile
            className="h-full transition-colors hover:bg-card motion-reduce:transition-none"
            icon={<FileText className="size-4" />}
            label="Invoices"
            value={`${invoiceCounts.total} total`}
            helper={`${invoiceCounts.paid} paid`}
          />
        </SuperLink>
      </EvidenceMetricStrip>
    </section>
  )
}

export function CustomerMetricsPanel({ customerId, currentAccess }: CustomerMetricsPanelProps) {
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
      usageExampleParams={buildCustomerUsageExampleParams(customerId, currentAccess)}
      showCustomerSummary={false}
      showHeaderControls={false}
    />
  )
}

const CUSTOMER_EVIDENCE_SKELETONS = ["usage", "ledger", "runs", "invoices"]

function buildCustomerUsageExampleParams(
  customerId: string,
  currentAccess: RouterOutputs["customers"]["getCurrentAccess"]
): SDKExampleParams {
  const usageEntitlement = currentAccess.entitlements.find((entitlement) => entitlement.meterConfig)

  if (!usageEntitlement?.meterConfig) {
    return { customerId }
  }

  return {
    customerId,
    usage: {
      featureSlug: usageEntitlement.featureSlug,
      eventSlug: usageEntitlement.meterConfig.eventSlug,
      aggregationMethod: usageEntitlement.meterConfig.aggregationMethod,
      aggregationField: usageEntitlement.meterConfig.aggregationField,
    },
  }
}

function formatSpendingSummary(summary: UsageDashboardData["summary"]["spending"]): string {
  if (summary.length === 0) {
    return "No spend"
  }

  return summary.map((item) => item.displayAmount).join(" + ")
}
