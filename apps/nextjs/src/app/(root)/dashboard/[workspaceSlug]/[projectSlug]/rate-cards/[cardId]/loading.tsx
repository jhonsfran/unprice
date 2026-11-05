import { Skeleton } from "@unprice/ui/skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"

export default function Loading() {
  return (
    <DashboardShell
      header={
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-72 max-w-full" />
          <Skeleton className="h-4 w-40" />
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </DashboardShell>
  )
}
