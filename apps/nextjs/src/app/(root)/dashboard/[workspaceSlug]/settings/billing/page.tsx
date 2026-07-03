import { getSession } from "@unprice/auth/server-rsc"
import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import { AlertCircle } from "lucide-react"
import type { SearchParams } from "nuqs/server"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { intervalParams } from "~/lib/searchParams"
import { HydrateClient, api } from "~/trpc/server"
import { WorkspaceBillingOverview } from "./_components/workspace-billing-overview"

export const dynamic = "force-dynamic"

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: { workspaceSlug: string }
  searchParams: SearchParams
}) {
  const { workspaceSlug } = params
  const session = await getSession()
  const atw = session?.user.workspaces.find((workspace) => workspace.slug === workspaceSlug)
  const isMainWorkspace = atw?.isMain
  const customerId = atw?.unPriceCustomerId ?? ""
  const filter = await intervalParams(searchParams)

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Billing & Usage"
          description="Plan, payment, and usage evidence for this workspace."
        />
      }
    >
      {isMainWorkspace ? (
        <Alert variant="info">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Main Workspace</AlertTitle>
          <AlertDescription>
            This is the main workspace. No billing customer context is required here.
          </AlertDescription>
        </Alert>
      ) : customerId ? (
        <WorkspaceBillingCard workspaceSlug={workspaceSlug} range={filter.intervalFilter} />
      ) : (
        <Alert variant="info">
          <AlertTitle>No billing customer context</AlertTitle>
          <AlertDescription>
            This workspace has no billing customer configured yet.
          </AlertDescription>
        </Alert>
      )}
    </DashboardShell>
  )
}

async function WorkspaceBillingCard({
  workspaceSlug,
  range,
}: {
  workspaceSlug: string
  range: Awaited<ReturnType<typeof intervalParams>>["intervalFilter"]
}) {
  try {
    const overview = await api.workspaces.getBillingOverview({
      workspaceSlug,
      range,
    })

    return (
      <HydrateClient>
        <WorkspaceBillingOverview
          initialOverview={overview}
          initialRange={range}
          workspaceSlug={workspaceSlug}
        />
      </HydrateClient>
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error while loading workspace billing"

    return (
      <Alert variant="info">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Workspace billing could not be loaded</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    )
  }
}
