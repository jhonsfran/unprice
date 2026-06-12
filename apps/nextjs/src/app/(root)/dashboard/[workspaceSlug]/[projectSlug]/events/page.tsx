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
        <HeaderTab title="Events" description="Recent ingestion events and processing outcomes" />
      }
    >
      <HydrateClient>
        <Suspense fallback={<div className="h-[420px] rounded-md border" />}>
          <IngestionEventsPanel />
        </Suspense>
      </HydrateClient>
    </DashboardShell>
  )
}
