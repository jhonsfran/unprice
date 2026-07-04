import { Skeleton } from "@unprice/ui/skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"

export default function ChangePlanPageLoading() {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Change plan"
          description="Choose the workspace plan and when the change should take effect."
          action={<Skeleton className="h-7 w-28" />}
        />
      }
    >
      <div className="flex flex-col gap-6">
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {["starter", "growth", "scale"].map((plan) => (
            <Skeleton key={plan} className="min-h-[420px] rounded-md border border-border/60" />
          ))}
        </section>
        <section className="rounded-md border border-border/60 px-4 py-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-4 w-[28rem] max-w-full" />
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <Skeleton className="h-14 rounded-md" />
              <Skeleton className="h-14 rounded-md" />
              <Skeleton className="h-14 rounded-md" />
            </div>
            <Skeleton className="h-9 w-40" />
          </div>
        </section>
      </div>
    </DashboardShell>
  )
}
