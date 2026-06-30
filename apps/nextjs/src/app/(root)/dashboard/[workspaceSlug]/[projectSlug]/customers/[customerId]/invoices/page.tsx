import { INVOICE_STATUS } from "@unprice/db/utils"
import { Typography } from "@unprice/ui/typography"
import { notFound } from "next/navigation"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { dataTableParams } from "~/lib/searchParams"
import { api } from "~/trpc/server"
import { columns as invoicesColumns } from "../../_components/invoices/table-invoices/columns"

export default async function CustomerPage(props: {
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

  const { customer, invoices, pageCount } = await api.customers.getInvoices({
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
          All invoices of this customer
        </Typography>
      </div>
      <Suspense
        fallback={
          <DataTableSkeleton
            columnCount={11}
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
              "8rem",
            ]}
          />
        }
      >
        <DataTable
          pageCount={pageCount}
          columns={invoicesColumns}
          data={invoices}
          emptyState={{
            title: "No invoices",
            description:
              "Invoices will appear here after this customer has billable subscriptions.",
          }}
          hidePaginationWhenEmpty
          filterOptions={{
            filterBy: "id",
            filterColumns: true,
            filterDateRange: true,
            filterServerSide: true,
            filterSelectors: {
              status: INVOICE_STATUS.map((value) => ({
                value: value,
                label: value,
              })),
            },
          }}
        />
      </Suspense>
    </div>
  )
}
