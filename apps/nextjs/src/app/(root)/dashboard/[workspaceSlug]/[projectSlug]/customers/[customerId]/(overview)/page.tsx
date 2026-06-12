import { Button } from "@unprice/ui/button"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Code } from "lucide-react"
import { notFound } from "next/navigation"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
import { intervalParams } from "~/lib/searchParams"
import { HydrateClient, api, batchPrefetch, trpc } from "~/trpc/server"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"
import { CustomerActions } from "../../_components/customers/customer-actions"
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
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers/${customerId}`
  const filter = intervalParams(searchParams)

  const { customer } = await api.customers.getSubscriptions({
    customerId,
  })

  if (!customer) {
    notFound()
  }

  batchPrefetch([
    trpc.analytics.getProjectUsage.queryOptions(
      {
        customerId,
        range: filter.intervalFilter,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
      }
    ),
    trpc.analytics.getProjectUsageTimeseries.queryOptions(
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
    <DashboardShell
      header={
        <HeaderTab
          title={customer.email}
          description={customer.description}
          label={customer.active ? "active" : "inactive"}
          id={customer.id}
          action={
            <div className="flex items-center gap-2">
              <CodeApiSheet defaultMethod="getUsage">
                <Button variant={"ghost"}>
                  <Code className="mr-2 h-4 w-4" />
                  API
                </Button>
              </CodeApiSheet>
              <CustomerActions customer={customer} />
            </div>
          }
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink asChild active>
            <SuperLink href={`${baseUrl}`}>Overview</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/subscriptions`}>Subscriptions</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/invoices`}>Invoices</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>

      <HydrateClient>
        <Suspense fallback={<CustomerMetricsPanelSkeleton />}>
          <CustomerMetricsPanel customerId={customerId} />
        </Suspense>
      </HydrateClient>
    </DashboardShell>
  )
}
