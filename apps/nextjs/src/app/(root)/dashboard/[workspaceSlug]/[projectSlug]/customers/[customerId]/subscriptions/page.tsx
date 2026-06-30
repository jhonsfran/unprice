import { SUBSCRIPTION_STATUS } from "@unprice/db/utils"
import { Typography } from "@unprice/ui/typography"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { api } from "~/trpc/server"
import { columns } from "../../_components/subscriptions/table-subscriptions/columns"

export default async function CustomerPage({
  params,
}: {
  params: {
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }
}) {
  const { customerId } = params

  const { customer } = await api.customers.getSubscriptions({
    customerId,
  })

  if (!customer) {
    notFound()
  }

  return (
    <div className="mt-4">
      <div className="flex flex-col px-1 py-4">
        <Typography variant="p" affects="removePaddingMargin">
          All subscriptions of this customer
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
          columns={columns}
          data={customer.subscriptions}
          emptyState={{
            title: "No subscriptions",
            description: "This customer does not have an active or historical subscription yet.",
          }}
          hidePaginationWhenEmpty
          filterOptions={{
            filterBy: "customerId",
            filterColumns: true,
            filterDateRange: true,
            filterServerSide: false,
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
  )
}
