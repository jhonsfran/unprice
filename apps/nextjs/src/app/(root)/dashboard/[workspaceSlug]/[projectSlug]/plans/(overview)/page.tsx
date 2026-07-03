import Balancer from "react-wrap-balancer"

import { FEATURE_SLUGS } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { Plus } from "@unprice/ui/icons"
import { Typography } from "@unprice/ui/typography"
import { Fragment } from "react"
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
