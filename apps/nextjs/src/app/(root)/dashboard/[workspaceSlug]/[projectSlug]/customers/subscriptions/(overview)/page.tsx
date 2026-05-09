import { SUBSCRIPTION_STATUS } from "@unprice/db/utils"
import { Button } from "@unprice/ui/button"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Typography } from "@unprice/ui/typography"
import { Code, Plus } from "lucide-react"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
import { dataTableParams } from "~/lib/searchParams"
import { api } from "~/trpc/server"
import { columns } from "../../_components/subscriptions/table-subscriptions/columns"

export default async function PlanSubscriptionsPage({
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
  const { workspaceSlug, projectSlug } = params
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers`
  const filters = dataTableParams(searchParams)

  const { subscriptions } = await api.subscriptions.listByActiveProject(filters)

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Subscriptions"
          description="Manages the subscriptions of your customers."
          action={
            <div className="flex items-center gap-2">
              <CodeApiSheet defaultMethod="getSubscription">
                <Button variant={"ghost"}>
                  <Code className="mr-2 h-4 w-4" />
                  API
                </Button>
              </CodeApiSheet>
              <SuperLink href={`/${workspaceSlug}/${projectSlug}/customers/subscriptions/new`}>
                <Button variant={"primary"}>
                  <Plus className="mr-2 h-4 w-4" />
                  Subscription
                </Button>
              </SuperLink>
            </div>
          }
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}`}>Customers</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild active>
            <SuperLink href={`${baseUrl}/subscriptions`}>Subscriptions</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>
      <div className="mt-4">
        <div className="flex flex-col px-1 py-4">
          <Typography variant="p" affects="removePaddingMargin">
            All active subscriptions
          </Typography>
        </div>
        <Suspense
          fallback={
            <DataTableSkeleton
              columnCount={12}
              rowCount={1}
              searchableColumnCount={1}
              filterableColumnCount={2}
              cellWidths={[
                "10rem",
                "40rem",
                "12rem",
                "12rem",
                "12rem",
                "12rem",
                "12rem",
                "12rem",
                "12rem",
                "12rem",
                "12rem",
                "8rem",
              ]}
            />
          }
        >
          <DataTable
            columns={columns}
            data={subscriptions}
            filterOptions={{
              filterBy: "customerId",
              filterColumns: true,
              filterDateRange: true,
              filterServerSide: true,
              filterSelectors: {
                status: SUBSCRIPTION_STATUS.map((value) => ({
                  value: value,
                  label: value,
                })),
              },
            }}
          />
        </Suspense>
      </div>
    </DashboardShell>
  )
}
