import { runStatusSchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Code } from "lucide-react"
import { notFound } from "next/navigation"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { SectionIntro } from "~/components/layout/section-intro"
import { dataTableParams } from "~/lib/searchParams"
import { api } from "~/trpc/server"
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
  const { customerId } = params
  const filters = dataTableParams(searchParams)

  const { customer, runs, pageCount } = await api.customers.getRuns({
    customerId,
    ...filters,
  })

  if (!customer) {
    notFound()
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <SectionIntro
        title="Budgeted runs for this customer"
        description="Runs label workload spend, reserve budget, and stop over-budget work before the customer creates more cost."
      />
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
            description: "Runs appear after your app starts a budgeted workload for this customer.",
            action: (
              <CodeApiSheet defaultMethod="startBudgetedRun" exampleParams={{ customerId }}>
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
  )
}
