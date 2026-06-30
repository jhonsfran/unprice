import { prepareInterval } from "@unprice/analytics"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { buildIngestionHealthInput } from "~/components/analytics/ingestion-health-query"
import { IntervalFilter } from "~/components/analytics/interval-filter"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { intervalParams } from "~/lib/searchParams"
import { HydrateClient, batchPrefetch, trpc } from "~/trpc/server"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"
import { OperationalHealth, OperationalHealthSkeleton } from "./_components/operational-health"
import OverviewStats, { OverviewStatsSkeleton } from "./_components/overview-stats"
import TabsDashboard from "./_components/tabs-dashboard"
import { UsageStats, UsageStatsSkeleton } from "./_components/usage-stats"

export const dynamic = "force-dynamic"

export default async function DashboardOverview(props: {
  params: { workspaceSlug: string; projectSlug: string }
  searchParams: SearchParams
}) {
  const { projectSlug, workspaceSlug } = props.params
  const baseUrl = `/${workspaceSlug}/${projectSlug}`
  const filter = intervalParams(props.searchParams)
  const now = Date.now()
  const interval = prepareInterval(filter.intervalFilter)
  const healthInput = buildIngestionHealthInput({ now, intervalMs: interval.intervalMs })

  batchPrefetch([
    trpc.analytics.getIngestionStatus.queryOptions(healthInput, {
      staleTime: 15 * 1000,
    }),
    trpc.analytics.getOverviewStats.queryOptions(
      {
        interval: filter.intervalFilter,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
      }
    ),
    trpc.analytics.getUsageDashboard.queryOptions(
      {
        range: filter.intervalFilter,
        topConsumersLimit: 10,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
      }
    ),
  ])

  return (
    <DashboardShell>
      <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
        <TabsDashboard baseUrl={baseUrl} activeTab="overview" />
        <IntervalFilter className="ml-auto" />
      </div>
      <HydrateClient>
        <div className="min-h-[170px]">
          <Suspense fallback={<OperationalHealthSkeleton />}>
            <OperationalHealth initialNow={now} />
          </Suspense>
        </div>

        <div className="min-h-[150px]">
          <Suspense fallback={<OverviewStatsSkeleton isLoading={true} />}>
            <OverviewStats />
          </Suspense>
        </div>

        <div className="min-h-[520px]">
          <Suspense fallback={<UsageStatsSkeleton />}>
            <UsageStats />
          </Suspense>
        </div>
      </HydrateClient>
    </DashboardShell>
  )
}
