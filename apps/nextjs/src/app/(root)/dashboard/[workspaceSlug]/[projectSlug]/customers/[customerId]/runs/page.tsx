import { runStatusSchema } from "@unprice/db/validators"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Typography } from "@unprice/ui/typography"
import { notFound } from "next/navigation"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
import { dataTableParams } from "~/lib/searchParams"
import { api } from "~/trpc/server"
import { CustomerActions } from "../../_components/customers/customer-actions"
import { columns as runsColumns } from "../../_components/runs/table-runs/columns"

export const dynamic = "force-dynamic"

export default async function CustomerRunsPage(props: {
  params: {
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }
  searchParams: SearchParams
}) {
  const { params, searchParams } = props
  const { workspaceSlug, projectSlug, customerId } = params
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers/${customerId}`
  const filters = dataTableParams(searchParams)

  const { customer, runs, pageCount } = await api.customers.getRuns({
    customerId,
    ...filters,
  })
  const tablePageCount = Math.max(pageCount, 1)

  if (!customer) {
    notFound()
  }

  return (
    <DashboardShell
      header={
        <HeaderTab
          title={customer.email}
          description={customer.description}
          label={customer.active ? "active" : "inactive"}
          id={customer.id}
          action={<CustomerActions customer={customer} />}
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}`}>Overview</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/subscriptions`}>Subscriptions</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/invoices`}>Invoices</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild active>
            <SuperLink href={`${baseUrl}/runs`}>Runs</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>
      <div className="mt-4">
        <div className="flex flex-col px-1 py-4">
          <Typography variant="p" affects="removePaddingMargin">
            Budgeted runs for this customer
          </Typography>
        </div>
        <Suspense
          fallback={
            <DataTableSkeleton
              columnCount={9}
              searchableColumnCount={1}
              filterableColumnCount={2}
              cellWidths={[
                "12rem",
                "10rem",
                "12rem",
                "14rem",
                "10rem",
                "10rem",
                "10rem",
                "12rem",
                "12rem",
              ]}
            />
          }
        >
          <DataTable
            pageCount={tablePageCount}
            columns={runsColumns}
            data={runs}
            filterOptions={{
              filterBy: "id",
              filterColumns: true,
              filterDateRange: true,
              filterServerSide: true,
              filterSelectors: {
                status: runStatusSchema.options.map((value) => ({
                  value,
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
