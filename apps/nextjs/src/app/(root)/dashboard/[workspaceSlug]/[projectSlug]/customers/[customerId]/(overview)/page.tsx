import { notFound } from "next/navigation"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { intervalParams } from "~/lib/searchParams"
import { HydrateClient, api, batchPrefetch, trpc } from "~/trpc/server"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"
import { CustomerMoneyPathSummary } from "../_components/customer-money-path-summary"
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
  const { workspaceSlug, projectSlug, customerId } = params
  const filter = intervalParams(searchParams)
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers/${customerId}`

  const [{ customer }, walletResult, entitlementsResult, economicSummary] = await Promise.all([
    api.customers.getSubscriptions({ customerId }),
    api.customers.getWallet({ customerId }),
    api.customers.getEntitlements({ customerId }),
    api.customers.getEconomicSummary({ customerId }),
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
      <CustomerMoneyPathSummary
        baseUrl={baseUrl}
        customer={customer}
        wallet={walletResult.wallet}
        entitlements={entitlementsResult.entitlements}
        summary={economicSummary}
      />
      <HydrateClient>
        <Suspense fallback={<CustomerMetricsPanelSkeleton />}>
          <CustomerMetricsPanel
            customerId={customerId}
            invoiceCount={economicSummary.invoiceCounts.total}
          />
        </Suspense>
      </HydrateClient>
    </div>
  )
}
