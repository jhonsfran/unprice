import { runStatusSchema } from "@unprice/db/validators"
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
import { columns as runsColumns } from "../../_components/runs/table-runs/columns"

export const dynamic = "force-dynamic"

export default async function ProjectRunsPage(props: {
  params: Promise<{
    workspaceSlug: string
    projectSlug: string
  }>
  searchParams: Promise<SearchParams>
}) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams])
  const { workspaceSlug, projectSlug } = params
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers`
  const filters = dataTableParams(searchParams)

  const { runs, pageCount } = await api.customers.listRunsByActiveProject(filters)

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Budgeted Runs"
          description="Budgeted run lifecycle, spend, and failure evidence across this project."
          action={
            <CodeApiSheet defaultMethod="startBudgetedRun">
              <Button variant={"ghost"}>
                <Code className="mr-2 h-4 w-4" />
                API
              </Button>
            </CodeApiSheet>
          }
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}`}>Customers</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/subscriptions`}>Subscriptions</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild active>
            <SuperLink href={`${baseUrl}/runs`}>Budgeted Runs</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>
      <div className="mt-4 flex flex-col gap-4">
        <Suspense
          fallback={
            <DataTableSkeleton
              columnCount={8}
              searchableColumnCount={1}
              filterableColumnCount={2}
              cellWidths={["16rem", "10rem", "20rem", "14rem", "10rem", "10rem", "12rem", "12rem"]}
            />
          }
        >
          <DataTable
            pageCount={pageCount}
            columns={runsColumns}
            data={runs}
            emptyState={{
              title: "No budgeted runs",
              description: "Runs appear after your app starts a budgeted workload for a customer.",
              action: (
                <CodeApiSheet defaultMethod="startBudgetedRun">
                  <Button size="sm" variant="outline">
                    <Code className="mr-2 size-4" />
                    Start budgeted run
                  </Button>
                </CodeApiSheet>
              ),
            }}
            hidePaginationWhenEmpty
            filterOptions={{
              filterBy: "customerId",
              filterPlaceholder: "Filter by customer, run, or workload",
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
