import { SUBSCRIPTION_STATUS } from "@unprice/db/utils"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { api } from "~/trpc/server"
import { columns } from "../../_components/subscriptions/table-subscriptions/columns"

export default async function CustomerPage(props: {
  params: Promise<{
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }>
}) {
  const params = await props.params
  const { customerId } = params

  const { customer } = await api.customers.getSubscriptions({
    customerId,
  })

  if (!customer) {
    notFound()
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Subscriptions pin this customer to plan versions and create billing periods, wallet policy,
        and invoice evidence.
      </p>
      <Suspense
        fallback={
          <DataTableSkeleton
            columnCount={9}
            searchableColumnCount={1}
            filterableColumnCount={2}
            cellWidths={[
              "4rem",
              "40rem",
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
          // the page is already scoped to one customer: hide the customer
          // column and low-signal metadata by default
          initialColumnVisibility={{ customerId: false, timezone: false }}
          emptyState={{
            title: "No subscriptions",
            description:
              "Subscriptions appear after this customer is assigned to a published plan version.",
          }}
          hidePaginationWhenEmpty
          filterOptions={{
            filterBy: "customerId",
            filterPlaceholder: "Filter by plan",
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
