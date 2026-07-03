import { FEATURE_SLUGS } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Code } from "lucide-react"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { columns } from "~/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/customers/table/columns"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import UpgradePlanError from "~/components/layout/error"
import HeaderTab from "~/components/layout/header-tab"
import { SectionIntro } from "~/components/layout/section-intro"
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
          description="Customers are the economic actors that hold subscriptions, wallet credits, invoices, and budgeted runs."
          action={
            <div className="flex items-center gap-2">
              <CodeApiSheet defaultMethod="signUpCustomer">
                <Button variant={"ghost"}>
                  <Code className="mr-2 h-4 w-4" />
                  Create via API
                </Button>
              </CodeApiSheet>
              <CustomerDialog>
                <Button>Customer</Button>
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
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/runs`}>Budgeted Runs</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>
      <div className="mt-4 flex flex-col gap-4">
        <SectionIntro
          title="Customer money state"
          description="Inspect which customers can be billed, which ones are active, and where to follow subscriptions, wallets, invoices, and runs."
        />
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
            emptyState={{
              title: "No customers yet",
              description:
                "Customers appear after signup or API creation. Create a customer before recording usage, assigning subscriptions, issuing wallet credits, or starting budgeted runs.",
              action: (
                <CodeApiSheet defaultMethod="signUpCustomer">
                  <Button size="sm" variant="outline">
                    <Code className="mr-2 size-4" />
                    Create via API
                  </Button>
                </CodeApiSheet>
              ),
            }}
            hidePaginationWhenEmpty
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
