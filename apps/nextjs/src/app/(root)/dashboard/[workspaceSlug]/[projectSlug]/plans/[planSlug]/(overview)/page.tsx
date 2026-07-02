import { CURRENCIES, STATUS_PLAN } from "@unprice/db/utils"
import { Button } from "@unprice/ui/button"
import { Separator } from "@unprice/ui/separator"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { BadgeCheck, Code, FilePenLine, Plus, Route, UsersRound } from "lucide-react"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { EvidenceMetricStrip, EvidenceMetricTile } from "~/components/analytics/evidence-panel"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SectionIntro } from "~/components/layout/section-intro"
import { SuperLink } from "~/components/super-link"
import { api } from "~/trpc/server"
import { PlanActions } from "../../_components/plan-actions"
import { PlanVersionDialog } from "../_components/plan-version-dialog"
import { columns } from "../_components/table-versions/columns"

export default async function PlanPage({
  params,
}: {
  params: {
    workspaceSlug: string
    projectSlug: string
    planSlug: string
  }
}) {
  const { planSlug, workspaceSlug, projectSlug } = params
  const baseUrl = `/${workspaceSlug}/${projectSlug}/plans/${planSlug}`
  const { getVersionsBySlug } = api.plans

  const { plan, project } = await getVersionsBySlug({
    slug: planSlug,
  })

  if (!plan) {
    notFound()
  }

  const publishedVersions = plan.versions.filter((version) => version.status === "published").length
  const draftVersions = plan.versions.filter((version) => version.status === "draft").length
  const assignedSubscriptions = plan.versions.reduce(
    (total, version) => total + version.subscriptions,
    0
  )

  return (
    <DashboardShell
      header={
        <HeaderTab
          title={plan.slug}
          id={plan.id}
          description={
            plan.description
              ? `${plan.description} Customers stay on the plan version they bought until migrated.`
              : "Customers stay on the plan version they bought until migrated."
          }
          label={plan.active ? "active" : "inactive"}
          action={
            <div className="flex items-center gap-2 rounded-md">
              <CodeApiSheet defaultMethod="listPlanVersions">
                <Button variant={"ghost"}>
                  <Code className="mr-2 h-4 w-4" />
                  API
                </Button>
              </CodeApiSheet>
              <div className="button-primary flex items-center gap-1 rounded-md">
                <div className="sm:col-span-full">
                  <PlanVersionDialog
                    defaultValues={{
                      planId: plan.id,
                      description: plan.description,
                      title: plan.title,
                      projectId: plan.projectId,
                      currency: project.defaultCurrency,
                      paymentProvider: "sandbox",
                      collectionMethod: "charge_automatically",
                      whenToBill: "pay_in_arrear",
                      trialUnits: 0,
                      autoRenew: true,
                      paymentMethodRequired: false,
                      billingConfig: {
                        name: "monthly",
                        billingInterval: "month",
                        billingIntervalCount: 1,
                        billingAnchor: "dayOfCreation",
                        planType: "recurring",
                      },
                      isDefault: plan.defaultPlan ?? false,
                    }}
                  >
                    <Button variant={"custom"}>
                      <Plus className="mr-2 h-4 w-4" /> Create version
                    </Button>
                  </PlanVersionDialog>
                </div>

                <Separator orientation="vertical" className="h-[20px] p-0" />

                <PlanActions plan={plan} />
              </div>
            </div>
          }
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink active asChild>
            <SuperLink prefetch={true} href={`${baseUrl}`}>
              Versions
            </SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>
      <div className="mt-4 flex flex-col gap-4">
        <SectionIntro
          title="Plan versions customers can be pinned to"
          description="Published versions are immutable pricing and entitlement rules. Draft versions stay editable until they are published."
        />
        <EvidenceMetricStrip className="sm:grid-cols-2 lg:grid-cols-4">
          <EvidenceMetricTile
            label="Versions"
            value={String(plan.versions.length)}
            helper="Draft and published"
            icon={<Route className="h-4 w-4" />}
          />
          <EvidenceMetricTile
            label="Published"
            value={String(publishedVersions)}
            helper="Usable by assigned customers"
            icon={<BadgeCheck className="h-4 w-4" />}
            tone={publishedVersions > 0 ? "success" : "default"}
          />
          <EvidenceMetricTile
            label="Draft"
            value={String(draftVersions)}
            helper="Editable before publish"
            icon={<FilePenLine className="h-4 w-4" />}
          />
          <EvidenceMetricTile
            label="Assigned subscriptions"
            value={String(assignedSubscriptions)}
            helper="Customers currently pinned to these versions"
            icon={<UsersRound className="h-4 w-4" />}
          />
        </EvidenceMetricStrip>
        <Suspense
          fallback={
            <DataTableSkeleton
              columnCount={12}
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
            data={plan.versions}
            emptyState={{
              title: "No versions",
              description: "Create a draft plan version before assigning customers to this plan.",
            }}
            hidePaginationWhenEmpty
            filterOptions={{
              filterBy: "title",
              filterColumns: true,
              filterDateRange: false,
              filterServerSide: false,
              filterSelectors: {
                status: STATUS_PLAN.map((value) => ({
                  value: value,
                  label: value,
                })),
                currency: CURRENCIES.map((value) => ({
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
