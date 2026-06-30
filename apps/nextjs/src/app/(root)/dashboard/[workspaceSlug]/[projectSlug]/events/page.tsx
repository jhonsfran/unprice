import { Skeleton } from "@unprice/ui/skeleton"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { HydrateClient } from "~/trpc/server"
import { IngestionEventsPanel } from "./_components/ingestion-events-panel"

export const dynamic = "force-dynamic"

export default async function ProjectEventsPage(_props: {
  params: { workspaceSlug: string; projectSlug: string }
  searchParams: SearchParams
}) {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Events"
          description="Ingestion events and processing outcomes — refreshes every 15s"
        />
      }
    >
      <HydrateClient>
        <Suspense
          fallback={
            <div className="flex flex-col gap-6">
              <Skeleton className="h-[250px] rounded-lg" />
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                <Skeleton className="h-[340px] rounded-lg" />
                <Skeleton className="h-[340px] rounded-lg" />
              </div>
              <Skeleton className="h-[520px] rounded-md" />
            </div>
          }
        >
          <IngestionEventsPanel />
        </Suspense>
      </HydrateClient>
    </DashboardShell>
  )
}
