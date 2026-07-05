import { Skeleton } from "@unprice/ui/skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { getPlanGridClassName } from "./_components/plan-grid"

const PLAN_CARD_SKELETONS = ["current-plan", "available-plan", "alternate-plan"]

export default function ChangePlanPageLoading() {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Change plan"
          description="Choose the workspace plan to change to."
          action={<Skeleton className="h-7 w-28" />}
        />
      }
    >
      <div className="flex flex-col gap-8 pt-3 md:gap-10 md:pt-5">
        <section className={getPlanGridClassName(PLAN_CARD_SKELETONS.length)}>
          {PLAN_CARD_SKELETONS.map((plan) => (
            <PlanCardSkeleton key={plan} />
          ))}
        </section>
      </div>
    </DashboardShell>
  )
}

function PlanCardSkeleton() {
  return (
    <div className="flex min-h-[420px] flex-col rounded-md border border-border/60 bg-card">
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-4 w-40" />
          </div>
          <Skeleton className="h-6 w-24" />
        </div>

        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>

        <Skeleton className="h-9 w-full" />
      </div>

      <div className="flex flex-1 flex-col gap-4 border-t px-6 py-6">
        <Skeleton className="h-4 w-28" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-5/6" />
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      </div>
    </div>
  )
}
