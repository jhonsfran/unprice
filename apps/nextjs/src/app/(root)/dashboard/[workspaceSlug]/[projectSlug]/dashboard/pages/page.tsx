import { prepareInterval, preparePage } from "@unprice/analytics"
import { FEATURE_SLUGS } from "@unprice/config"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { IntervalFilter } from "~/components/analytics/interval-filter"
import { PageFilter } from "~/components/analytics/page-filter"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import UpgradePlanError from "~/components/layout/error"
import { entitlementFlag } from "~/lib/flags"
import { intervalParams, pageParams } from "~/lib/searchParams"
import { HydrateClient, api, batchPrefetch, trpc } from "~/trpc/server"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"
import { Browsers, BrowsersSkeleton } from "../_components/browsers"
import { Countries, CountriesSkeleton } from "../_components/countries"
import { PageVisits, PageVisitsSkeleton } from "../_components/page-visits"
import TabsDashboard from "../_components/tabs-dashboard"

export const dynamic = "force-dynamic"

export default async function DashboardPages(props: {
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
        returnTo={`/${workspaceSlug}/${projectSlug}/dashboard/pages`}
      />
    )
  }

  const baseUrl = `/${workspaceSlug}/${projectSlug}`
  const intervalFilter = intervalParams(searchParams)
  const pageFilter = pageParams(searchParams)

  const interval = prepareInterval(intervalFilter.intervalFilter)
  const page = preparePage(pageFilter.pageId)

  batchPrefetch([
    trpc.analytics.getPagesOverview.queryOptions(
      {
        interval_days: interval.intervalDays,
        page_id: page.pageId,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
        enabled: page.isSelected,
      }
    ),
    trpc.analytics.getCountryVisits.queryOptions(
      {
        interval_days: interval.intervalDays,
        page_id: page.pageId,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
        enabled: page.isSelected,
      }
    ),
    trpc.analytics.getBrowserVisits.queryOptions(
      {
        interval_days: interval.intervalDays,
        page_id: page.pageId,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
        enabled: page.isSelected,
      }
    ),
  ])

  return (
    <DashboardShell>
      <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
        <TabsDashboard baseUrl={baseUrl} activeTab="pages" />
        <div className="flex items-center gap-2">
          <IntervalFilter className="md:ml-auto" />
          <Suspense fallback={<div className="h-9 w-44" />}>
            <PageFilter className="ml-auto" pagesPromise={api.pages.listByActiveProject({})} />
          </Suspense>
        </div>
      </div>
      <HydrateClient>
        <Suspense fallback={<PageVisitsSkeleton isLoading={true} />}>
          <PageVisits />
        </Suspense>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Suspense fallback={<BrowsersSkeleton isLoading={true} />}>
            <Browsers />
          </Suspense>
          <Suspense fallback={<CountriesSkeleton isLoading={true} />}>
            <Countries />
          </Suspense>
        </div>
      </HydrateClient>
    </DashboardShell>
  )
}
