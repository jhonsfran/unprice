import { SUBSCRIPTION_STATUS } from "@unprice/db/utils"
import { BadgeCheck, FileClock, Layers3 } from "lucide-react"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { EvidenceMetricStrip, EvidenceMetricTile } from "~/components/analytics/evidence-panel"
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

  const activeSubscriptions = customer.subscriptions.filter(
    (subscription) => subscription.active
  ).length
  const pendingSubscriptions = customer.subscriptions.filter(
    (subscription) =>
      subscription.status === "pending_payment" || subscription.status === "pending_activation"
  ).length

  return (
    <div className="mt-4 flex flex-col gap-4">
      <SectionIntro
        title="Subscriptions for this customer"
        description="Subscriptions pin this customer to plan versions and create billing periods, wallet policy, and invoice evidence."
      />
      <EvidenceMetricStrip className="sm:grid-cols-3">
        <EvidenceMetricTile
          label="Subscriptions"
          value={String(customer.subscriptions.length)}
          helper="Active and historical"
          icon={<Layers3 className="h-4 w-4" />}
        />
        <EvidenceMetricTile
          label="Active"
          value={String(activeSubscriptions)}
          helper="Currently governing access"
          icon={<BadgeCheck className="h-4 w-4" />}
          tone={activeSubscriptions > 0 ? "success" : "default"}
        />
        <EvidenceMetricTile
          label="Pending"
          value={String(pendingSubscriptions)}
          helper="Waiting on payment or activation"
          icon={<FileClock className="h-4 w-4" />}
          tone={pendingSubscriptions > 0 ? "warning" : "default"}
        />
      </EvidenceMetricStrip>
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
