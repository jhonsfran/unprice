import { Skeleton } from "@unprice/ui/skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { RATE_CARDS_DESCRIPTION } from "../_components/rate-card-format"

export default function Loading() {
  return (
    <DashboardShell header={<HeaderTab title="Rate cards" description={RATE_CARDS_DESCRIPTION} />}>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </DashboardShell>
  )
}
