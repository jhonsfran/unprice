import { SUBSCRIPTION_STATUS } from "@unprice/db/utils"
import { Button } from "@unprice/ui/button"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Code } from "lucide-react"
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

export default async function PlanSubscriptionsPage(props: {
  params: Promise<{
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }>
  searchParams: Promise<SearchParams>
}) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams])
  const { workspaceSlug, projectSlug } = params
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers`
  const filters = dataTableParams(searchParams)

  const { subscriptions } = await api.subscriptions.listByActiveProject(filters)

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Subscriptions"
          description="Connect customers to plan versions, billing periods, wallet policy, and invoice evidence."
          action={
            <div className="flex items-center gap-2">
              <CodeApiSheet defaultMethod="getSubscription">
                <Button variant={"link"}>
                  <Code className="mr-2 h-4 w-4" />
                  API
                </Button>
              </CodeApiSheet>
              <SuperLink href={`/${workspaceSlug}/${projectSlug}/customers/subscriptions/new`}>
                <Button variant={"primary"}>Create Subscription</Button>
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
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/runs`}>Budgeted Runs</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>
      <div className="mt-4 flex flex-col gap-4">
        <Suspense
          fallback={
            <DataTableSkeleton
              columnCount={9}
              rowCount={1}
              searchableColumnCount={1}
              filterableColumnCount={2}
              cellWidths={[
                "4rem",
                "40rem",
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
            initialColumnVisibility={{ timezone: false }}
            emptyState={{
              title: "No subscriptions",
              description:
                "Subscriptions appear after customers are assigned to published plan versions.",
              action: (
                <CodeApiSheet defaultMethod="signUpCustomer">
                  <Button size="sm" variant="outline">
                    <Code className="mr-2 size-4" />
                    API
                  </Button>
                </CodeApiSheet>
              ),
            }}
            hidePaginationWhenEmpty
            filterOptions={{
              filterBy: "customerId",
              filterPlaceholder: "Filter by customer or plan",
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
