import { notFound } from "next/navigation"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { intervalParams } from "~/lib/searchParams"
import { HydrateClient, api, batchPrefetch, trpc } from "~/trpc/server"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"
import { CustomerCurrentAccess } from "../_components/customer-current-access"
import {
  CustomerEvidenceSummary,
  CustomerEvidenceSummarySkeleton,
  CustomerMetricsPanel,
  CustomerMetricsPanelSkeleton,
} from "../_components/usage/customer-metrics-panel"

export const dynamic = "force-dynamic"

export default async function CustomerUsagePage({
  params,
  searchParams,
}: {
  params: {
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }
  searchParams: SearchParams
}) {
  const { workspaceSlug, projectSlug, customerId } = params
  const filter = intervalParams(searchParams)
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers/${customerId}`

  const [{ customer }, walletResult, economicSummary, currentAccess] = await Promise.all([
    api.customers.getSubscriptions({ customerId }),
    api.customers.getWallet({ customerId }),
    api.customers.getEconomicSummary({ customerId }),
    api.customers.getCurrentAccess({ customerId }),
  ])

  if (!customer) {
    notFound()
  }

  batchPrefetch([
    trpc.analytics.getUsageDashboard.queryOptions(
      {
        customerId,
        range: filter.intervalFilter,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
      }
    ),
  ])

  return (
    <div className="flex flex-col gap-6">
      <HydrateClient>
        <Suspense fallback={<CustomerEvidenceSummarySkeleton />}>
          <CustomerEvidenceSummary
            customerId={customerId}
            baseUrl={baseUrl}
            runCounts={economicSummary.runCounts}
            invoiceCounts={economicSummary.invoiceCounts}
          />
        </Suspense>
        <CustomerCurrentAccess
          access={currentAccess}
          wallet={walletResult.wallet}
          subscriptionsHref={`${baseUrl}/subscriptions`}
        />
        <Suspense fallback={<CustomerMetricsPanelSkeleton />}>
          <CustomerMetricsPanel customerId={customerId} />
        </Suspense>
      </HydrateClient>
    </div>
  )
}
