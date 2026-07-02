import { SUBSCRIPTION_STATUS } from "@unprice/db/utils"
import { Button } from "@unprice/ui/button"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { BadgeCheck, Code, FileClock, Layers3, Plus, ReceiptText } from "lucide-react"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { EvidenceMetricStrip, EvidenceMetricTile } from "~/components/analytics/evidence-panel"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SectionIntro } from "~/components/layout/section-intro"
import { SuperLink } from "~/components/super-link"
import { dataTableParams } from "~/lib/searchParams"
import { api } from "~/trpc/server"
import { columns } from "../../_components/subscriptions/table-subscriptions/columns"

export default async function PlanSubscriptionsPage({
  params,
  searchParams,
}: {
  params: {
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }
  searchParams: SearchParams
}) {
  const { workspaceSlug, projectSlug } = params
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers`
  const filters = dataTableParams(searchParams)

  const { subscriptions, pageCount } = await api.subscriptions.listByActiveProject(filters)
  const activeSubscriptions = subscriptions.filter((subscription) => subscription.active).length
  const pendingSubscriptions = subscriptions.filter(
    (subscription) =>
      subscription.status === "pending_payment" || subscription.status === "pending_activation"
  ).length

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Subscriptions"
          description="Connect customers to plan versions, billing periods, wallet policy, and invoice evidence."
          action={
            <div className="flex items-center gap-2">
              <CodeApiSheet defaultMethod="getSubscription">
                <Button variant={"ghost"}>
                  <Code className="mr-2 h-4 w-4" />
                  API
                </Button>
              </CodeApiSheet>
              <SuperLink href={`/${workspaceSlug}/${projectSlug}/customers/subscriptions/new`}>
                <Button variant={"primary"}>
                  <Plus className="mr-2 h-4 w-4" />
                  Subscription
                </Button>
              </SuperLink>
            </div>
          }
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}`}>Customers</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild active>
            <SuperLink href={`${baseUrl}/subscriptions`}>Subscriptions</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/runs`}>Budgeted Runs</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>
      <div className="mt-4 flex flex-col gap-4">
        <SectionIntro
          title="Subscription evidence across this project"
          description="Subscriptions connect customers to plan versions, billing periods, wallet policy, and invoice evidence."
        />
        <EvidenceMetricStrip className="sm:grid-cols-2 lg:grid-cols-4">
          <EvidenceMetricTile
            label="Visible subscriptions"
            value={String(subscriptions.length)}
            helper={`${pageCount} result ${pageCount === 1 ? "page" : "pages"}`}
            icon={<Layers3 className="h-4 w-4" />}
          />
          <EvidenceMetricTile
            label="Active"
            value={String(activeSubscriptions)}
            helper="Currently governing customer access"
            icon={<BadgeCheck className="h-4 w-4" />}
            tone={activeSubscriptions > 0 ? "success" : "default"}
          />
          <EvidenceMetricTile
            label="Pending"
            value={String(pendingSubscriptions)}
            helper="Waiting on payment or setup"
            icon={<FileClock className="h-4 w-4" />}
            tone={pendingSubscriptions > 0 ? "warning" : "default"}
          />
          <EvidenceMetricTile
            label="Invoice path"
            value="Connected"
            helper="Subscription phases create invoice evidence"
            icon={<ReceiptText className="h-4 w-4" />}
          />
        </EvidenceMetricStrip>
        <Suspense
          fallback={
            <DataTableSkeleton
              columnCount={12}
              rowCount={1}
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
                "12rem",
                "8rem",
              ]}
            />
          }
        >
          <DataTable
            columns={columns}
            data={subscriptions}
            emptyState={{
              title: "No subscriptions",
              description:
                "Subscriptions appear after customers are assigned to published plan versions.",
            }}
            hidePaginationWhenEmpty
            filterOptions={{
              filterBy: "customerId",
              filterColumns: true,
              filterDateRange: true,
              filterServerSide: true,
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
    </DashboardShell>
  )
}
