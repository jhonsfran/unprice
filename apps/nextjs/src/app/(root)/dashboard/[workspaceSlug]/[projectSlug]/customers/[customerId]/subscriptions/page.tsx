import { SUBSCRIPTION_STATUS } from "@unprice/db/utils"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { SectionIntro } from "~/components/layout/section-intro"
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
    <div className="mt-4 flex flex-col gap-4">
      <SectionIntro
        title="Subscriptions for this customer"
        description="Subscriptions pin this customer to plan versions and create billing periods, wallet policy, and invoice evidence."
      />
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
          emptyState={{
            title: "No subscriptions",
            description:
              "Subscriptions appear after this customer is assigned to a published plan version.",
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
