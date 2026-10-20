import { Skeleton } from "@unprice/ui/skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { BudgetLiveSkeleton } from "../_components/budget-live"

export default function Loading() {
  return (
    <DashboardShell
      header={
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-24" />
        </div>
      }
    >
      <BudgetLiveSkeleton />
    </DashboardShell>
  )
}
