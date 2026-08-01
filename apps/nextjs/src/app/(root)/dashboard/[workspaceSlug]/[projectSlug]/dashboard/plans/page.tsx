import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"

import { prepareInterval } from "@unprice/analytics"
import { FEATURE_SLUGS } from "@unprice/config"
import { IntervalFilter } from "~/components/analytics/interval-filter"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import UpgradePlanError from "~/components/layout/error"
import { entitlementFlag } from "~/lib/flags"
import { intervalParams } from "~/lib/searchParams"
import { HydrateClient, batchPrefetch, trpc } from "~/trpc/server"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"
import { PlansConversion, PlansConversionSkeleton } from "../_components/plans-convertion"
import PlansStats, { PlansStatsSkeleton } from "../_components/plans-stats"
import TabsDashboard from "../_components/tabs-dashboard"

export const dynamic = "force-dynamic"

export default async function DashboardPlans(props: {
  params: Promise<{ workspaceSlug: string; projectSlug: string }>
  searchParams: Promise<SearchParams>
}) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams])
  const { projectSlug, workspaceSlug } = params
  const isPagesEnabled = await entitlementFlag(FEATURE_SLUGS.PAGES.SLUG)

  if (!isPagesEnabled) {
    return (
      <UpgradePlanError
        workspaceSlug={workspaceSlug}
        blockedFeatureSlug={FEATURE_SLUGS.PAGES.SLUG}
        returnTo={`/${workspaceSlug}/${projectSlug}/dashboard/plans`}
        title="Plan conversion analytics needs hosted pages"
        description="Conversion evidence comes from hosted signup and pricing pages. Upgrade to create pages tied to published plan versions."
      />
    )
  }

  const baseUrl = `/${workspaceSlug}/${projectSlug}`
  const filter = intervalParams(searchParams)
  const interval = prepareInterval(filter.intervalFilter)

  // prefetch
  batchPrefetch([
    trpc.analytics.getPlansStats.queryOptions(
      { interval: filter.intervalFilter },
      {
        ...ANALYTICS_CONFIG_REALTIME,
      }
    ),
    trpc.analytics.getPlansConversion.queryOptions(
      {
        interval_days: interval.intervalDays,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
      }
    ),
  ])

  return (
    <DashboardShell>
      <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
        <TabsDashboard baseUrl={baseUrl} activeTab="plans" />
        <Suspense fallback={<div className="h-9 w-44" />}>
          <IntervalFilter className="ml-auto" />
        </Suspense>
      </div>
      <HydrateClient>
        <Suspense fallback={<PlansStatsSkeleton isLoading={true} />}>
          <PlansStats />
        </Suspense>
        <Suspense fallback={<PlansConversionSkeleton />}>
          <PlansConversion />
        </Suspense>
      </HydrateClient>
    </DashboardShell>
  )
}
