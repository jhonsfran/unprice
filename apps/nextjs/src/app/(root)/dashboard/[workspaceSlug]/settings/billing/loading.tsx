import { Skeleton } from "@unprice/ui/skeleton"
import { UsageDashboardSkeleton } from "~/components/analytics/usage-dashboard-view"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"

export default function BillingPageLoading() {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Billing & Usage"
          description="Plan, payment, and usage evidence for this workspace."
        />
      }
    >
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-4 w-[34rem] max-w-full" />
          </div>
          <div className="grid gap-4 lg:grid-cols-[0.95fr_1.55fr]">
            <Skeleton className="h-[360px] rounded-md border border-border/60" />
            <Skeleton className="h-[360px] rounded-md border border-border/60" />
          </div>
        </section>
        <UsageDashboardSkeleton />
      </div>
    </DashboardShell>
  )
}
