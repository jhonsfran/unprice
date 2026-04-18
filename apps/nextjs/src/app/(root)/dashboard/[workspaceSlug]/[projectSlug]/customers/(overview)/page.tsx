import { FEATURE_SLUGS } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Typography } from "@unprice/ui/typography"
import { Code, Plus } from "lucide-react"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { columns } from "~/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/customers/table/columns"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import UpgradePlanError from "~/components/layout/error"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
import { entitlementFlag } from "~/lib/flags"
import { dataTableParams } from "~/lib/searchParams"
import { api } from "~/trpc/server"
import { CustomerDialog } from "../_components/customers/customer-dialog"

export default async function ProjectUsersPage(props: {
  params: { workspaceSlug: string; projectSlug: string; customerId: string }
  searchParams: SearchParams
}) {
  const { workspaceSlug, projectSlug } = props.params
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers`
  const filters = dataTableParams(props.searchParams)

  const isCustomersEnabled = await entitlementFlag(FEATURE_SLUGS.CUSTOMERS.SLUG)

  if (!isCustomersEnabled) {
    return <UpgradePlanError />
  }

  const { customers, pageCount } = await api.customers.listByActiveProject(filters)

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Customers"
          description="Manage your customers"
          action={
            <div className="flex items-center gap-2">
              <CodeApiSheet defaultMethod="signUp">
                <Button variant={"ghost"}>
                  <Code className="mr-2 h-4 w-4" />
                  API
                </Button>
              </CodeApiSheet>
              <CustomerDialog>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Customer
                </Button>
              </CustomerDialog>
            </div>
          }
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink active asChild>
            <SuperLink href={`${baseUrl}`}>Customers</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/subscriptions`}>Subscriptions</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>
      <div className="mt-4">
        <div className="flex flex-col px-1 py-4">
          <Typography variant="p" affects="removePaddingMargin">
            All customers for this project
          </Typography>
        </div>

        <Suspense
          fallback={
            <DataTableSkeleton
              columnCount={8}
              showDateFilterOptions={true}
              showViewOptions={true}
              searchableColumnCount={1}
              cellWidths={["10rem", "30rem", "20rem", "20rem", "20rem", "20rem", "12rem", "8rem"]}
            />
          }
        >
          <DataTable
            pageCount={pageCount}
            columns={columns}
            data={customers}
            filterOptions={{
              filterBy: "email",
              filterColumns: true,
              filterDateRange: true,
              filterServerSide: false,
            }}
          />
        </Suspense>
      </div>
    </DashboardShell>
  )
}
