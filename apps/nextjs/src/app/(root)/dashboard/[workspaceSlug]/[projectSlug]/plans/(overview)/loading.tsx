import { Button } from "@unprice/ui/button"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { PlanDialog } from "../_components/plan-dialog"
import { PlanCardSkeleton } from "./_components/plan-card"

export default function Loading() {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Plans"
          description="Define plans, features, meters, and limits without hardcoding the money path."
          action={
            <PlanDialog>
              <Button>Create plan</Button>
            </PlanDialog>
          }
        />
      }
    >
      <ul className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <li>
          <PlanCardSkeleton />
        </li>
        <li>
          <PlanCardSkeleton />
        </li>
        <li>
          <PlanCardSkeleton />
        </li>
      </ul>
    </DashboardShell>
  )
}
