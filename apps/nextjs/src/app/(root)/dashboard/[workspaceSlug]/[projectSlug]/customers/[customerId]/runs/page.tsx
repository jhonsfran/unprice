import { runStatusSchema } from "@unprice/db/validators"
import { Typography } from "@unprice/ui/typography"
import { notFound } from "next/navigation"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
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
          pageCount={pageCount}
          columns={runsColumns}
          data={runs}
          emptyState={{
            title: "No runs",
            description: "Budgeted runs will appear after usage is evaluated for this customer.",
          }}
          hidePaginationWhenEmpty
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
  )
}
