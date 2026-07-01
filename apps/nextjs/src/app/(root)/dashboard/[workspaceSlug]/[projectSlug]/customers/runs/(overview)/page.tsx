import { runStatusSchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Typography } from "@unprice/ui/typography"
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

export default async function ProjectRunsPage({
  params,
  searchParams,
}: {
  params: {
    workspaceSlug: string
    projectSlug: string
  }
  searchParams: SearchParams
}) {
  const { workspaceSlug, projectSlug } = params
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers`
  const filters = dataTableParams(searchParams)

  const { runs, pageCount } = await api.customers.listRunsByActiveProject(filters)

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Runs"
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
            <SuperLink href={`${baseUrl}/runs`}>Runs</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>
      <div className="mt-4">
        <div className="flex flex-col px-1 py-4">
          <Typography variant="p" affects="removePaddingMargin">
            Budgeted runs across all customers in this project.
          </Typography>
        </div>
        <Suspense
          fallback={
            <DataTableSkeleton
              columnCount={8}
              searchableColumnCount={1}
              filterableColumnCount={2}
              cellWidths={[
                "16rem",
                "10rem",
                "20rem",
                "14rem",
                "10rem",
                "10rem",
                "12rem",
                "12rem",
              ]}
            />
          }
        >
          <DataTable
            pageCount={pageCount}
            columns={runsColumns}
            data={runs}
            emptyState={{
              title: "No budgeted runs",
              description:
                "Runs will appear after your app starts budgeted workloads for customers.",
              action: (
                <CodeApiSheet defaultMethod="startBudgetedRun">
                  <Button size="sm">
                    <Code className="mr-2 size-4" />
                    Start budgeted run
                  </Button>
                </CodeApiSheet>
              ),
            }}
            hidePaginationWhenEmpty
            filterOptions={{
              filterBy: "customerId",
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
