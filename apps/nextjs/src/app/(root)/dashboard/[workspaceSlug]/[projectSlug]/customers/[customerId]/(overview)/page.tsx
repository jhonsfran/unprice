import { notFound } from "next/navigation"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { intervalParams } from "~/lib/searchParams"
import { HydrateClient, api, batchPrefetch, trpc } from "~/trpc/server"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"
import { CustomerCurrentAccess } from "../_components/customer-current-access"
import {
  CustomerMetricsPanel,
  CustomerMetricsPanelSkeleton,
} from "../_components/usage/customer-metrics-panel"

export const dynamic = "force-dynamic"

export default async function CustomerUsagePage(props: {
  params: Promise<{
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }>
  searchParams: Promise<SearchParams>
}) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams])
  const { workspaceSlug, projectSlug, customerId } = params
  const filter = intervalParams(searchParams)
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers/${customerId}`

  const [{ customer }, walletResult, currentAccess] = await Promise.all([
    api.customers.getSubscriptions({ customerId }),
    api.customers.getWallet({ customerId }),
    api.customers.getCurrentAccess({ customerId }),
  ])

  if (!customer) {
    notFound()
  }

  batchPrefetch([
    trpc.customers.getCurrentEntitlements.queryOptions(
      {
        customerId,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
      }
    ),
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
    <HydrateClient>
      <div className="flex flex-col gap-6 space-y-6">
        <CustomerCurrentAccess
          access={currentAccess}
          wallet={walletResult.wallet}
          plansHref={`/${workspaceSlug}/${projectSlug}/plans`}
          subscriptionsHref={`${baseUrl}/subscriptions`}
        />
        <Suspense fallback={<CustomerMetricsPanelSkeleton />}>
          <CustomerMetricsPanel customerId={customerId} currentAccess={currentAccess} />
        </Suspense>
      </div>
    </HydrateClient>
  )
}
