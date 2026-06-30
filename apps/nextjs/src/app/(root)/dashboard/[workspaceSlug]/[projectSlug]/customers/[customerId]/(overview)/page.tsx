import { notFound } from "next/navigation"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { intervalParams } from "~/lib/searchParams"
import { HydrateClient, api, batchPrefetch, trpc } from "~/trpc/server"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"
import {
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
  const { customerId } = params
  const filter = intervalParams(searchParams)

  const { customer } = await api.customers.getSubscriptions({
    customerId,
  })

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
    <HydrateClient>
      <Suspense fallback={<CustomerMetricsPanelSkeleton />}>
        <CustomerMetricsPanel customerId={customerId} invoiceCount={customer.invoices.length} />
      </Suspense>
    </HydrateClient>
  )
}
