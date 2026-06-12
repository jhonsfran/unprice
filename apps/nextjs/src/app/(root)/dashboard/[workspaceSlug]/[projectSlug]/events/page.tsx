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
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={`skeleton-${
                      // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
                      i
                    }`}
                    className="h-[100px] animate-pulse rounded-lg border bg-muted/20"
                  />
                ))}
              </div>
              <div className="h-[520px] animate-pulse rounded-md border bg-muted/10" />
            </div>
          }
        >
          <IngestionEventsPanel />
        </Suspense>
      </HydrateClient>
    </DashboardShell>
  )
}
