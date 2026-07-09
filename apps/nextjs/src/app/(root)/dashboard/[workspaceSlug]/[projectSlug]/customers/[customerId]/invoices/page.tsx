import { INVOICE_STATUS } from "@unprice/db/utils"
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
    <div className="mt-4 flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Explain invoice state from subscription, plan version, usage, wallet, and settlement
        evidence.
      </p>
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
              "Invoices appear after this customer has billable subscriptions and rated usage or recurring charges.",
          }}
          hidePaginationWhenEmpty
          filterOptions={{
            filterBy: "id",
            filterPlaceholder: "Filter by invoice id",
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
