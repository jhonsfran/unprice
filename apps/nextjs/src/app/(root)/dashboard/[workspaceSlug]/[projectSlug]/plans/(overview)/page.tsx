import Balancer from "react-wrap-balancer"

import { FEATURE_SLUGS } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { Plus } from "@unprice/ui/icons"
import { Typography } from "@unprice/ui/typography"
import { BadgeCheck, FilePenLine, Layers3, Route } from "lucide-react"
import { Fragment } from "react"
import { EvidenceMetricStrip, EvidenceMetricTile } from "~/components/analytics/evidence-panel"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import UpgradePlanError from "~/components/layout/error"
import HeaderTab from "~/components/layout/header-tab"
import { entitlementFlag } from "~/lib/flags"
import { api } from "~/trpc/server"
import { PlanDialog } from "../_components/plan-dialog"
import { PlanCard, PlanCardSkeleton } from "./_components/plan-card"
export default async function PlansPage(props: {
  params: { workspaceSlug: string; projectSlug: string }
  searchParams: Record<string, string | string[] | undefined>
}) {
  const { projectSlug, workspaceSlug } = props.params

  const isPlansEnabled = await entitlementFlag(FEATURE_SLUGS.PLANS.SLUG)

  if (!isPlansEnabled) {
    return <UpgradePlanError />
  }

  const { plans } = await api.plans.listByActiveProject({})
  const versions = plans.flatMap((plan) => plan.versions)
  const publishedVersions = versions.filter((version) => version.status === "published").length
  const draftVersions = versions.filter((version) => version.status === "draft").length
  const activePlans = plans.filter((plan) => plan.active).length

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Plans"
          description="Define plans, features, meters, and limits without hardcoding the money path."
          action={
            <PlanDialog>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Create plan
              </Button>
            </PlanDialog>
          }
        />
      }
    >
      <Fragment>
        <EvidenceMetricStrip className="sm:grid-cols-2 lg:grid-cols-4">
          <EvidenceMetricTile
            label="Plans"
            value={String(plans.length)}
            helper={`${activePlans} active`}
            icon={<Layers3 className="h-4 w-4" />}
          />
          <EvidenceMetricTile
            label="Published versions"
            value={String(publishedVersions)}
            helper="Usable by assigned customers"
            icon={<BadgeCheck className="h-4 w-4" />}
            tone={publishedVersions > 0 ? "success" : "default"}
          />
          <EvidenceMetricTile
            label="Draft versions"
            value={String(draftVersions)}
            helper="Editable before publish"
            icon={<FilePenLine className="h-4 w-4" />}
          />
          <EvidenceMetricTile
            label="Money path"
            value="Versioned"
            helper="Features, meters, limits, and billing stay connected"
            icon={<Route className="h-4 w-4" />}
          />
        </EvidenceMetricStrip>

        <ul className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {plans.map((plan) => (
            <li key={plan.id}>
              <PlanCard plan={plan} workspaceSlug={workspaceSlug} projectSlug={projectSlug} />
            </li>
          ))}
        </ul>

        {plans.length === 0 && (
          <div className="relative">
            <ul className="grid select-none grid-cols-1 gap-4 opacity-40 lg:grid-cols-3">
              <PlanCardSkeleton pulse={false} />
              <PlanCardSkeleton pulse={false} />
              <PlanCardSkeleton pulse={false} />
            </ul>
            <div className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 w-full text-center">
              <Balancer>
                <Typography variant="h2">No plans yet.</Typography>
                <Typography variant="large">
                  Create a plan to define features, meters, limits, and billing behavior.
                </Typography>
              </Balancer>
            </div>
          </div>
        )}
      </Fragment>
    </DashboardShell>
  )
}
