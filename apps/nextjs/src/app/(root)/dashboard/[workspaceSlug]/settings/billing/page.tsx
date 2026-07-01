import { getSession } from "@unprice/auth/server-rsc"
import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import { AlertCircle } from "lucide-react"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { api } from "~/trpc/server"
import { UsageDashboard } from "./_components/usage-dashboard"

export default async function BillingPage({ params }: { params: { workspaceSlug: string } }) {
  const { workspaceSlug } = params
  const session = await getSession()
  const atw = session?.user.workspaces.find((w) => w.slug === workspaceSlug)
  const isMainWorkspace = atw?.isMain
  const customerId = atw?.unPriceCustomerId ?? ""

  if (isMainWorkspace) {
    return (
      <DashboardShell
        header={
          <HeaderTab
            title="Workspace usage evidence"
            description="Usage, billing, and invoice activity reported for this workspace."
          />
        }
      >
        <Alert variant="info">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Main Workspace</AlertTitle>
          <AlertDescription>
            This is the main workspace. No billing customer context is required here.
          </AlertDescription>
        </Alert>
      </DashboardShell>
    )
  }

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Workspace usage evidence"
          description="Usage, billing, and invoice activity reported for this workspace."
        />
      }
    >
      <UsageCard customerId={customerId} workspaceSlug={workspaceSlug} />
    </DashboardShell>
  )
}

async function UsageCard({
  customerId,
  workspaceSlug,
}: { customerId: string; workspaceSlug: string }) {
  if (!customerId) {
    return (
      <Alert variant="info">
        <AlertTitle>No billing customer context</AlertTitle>
        <AlertDescription>This workspace has no billing customer configured yet.</AlertDescription>
      </Alert>
    )
  }

  try {
    const usageData = await api.analytics.getUsage({
      customerId: customerId,
      range: "30d",
    })

    if (usageData.error) {
      return (
        <Alert variant="info">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Usage evidence could not be loaded</AlertTitle>
          <AlertDescription>{usageData.error}</AlertDescription>
        </Alert>
      )
    }

    if (!usageData.usage || usageData.usage.length === 0) {
      return (
        <Alert variant="info">
          <AlertTitle>No usage evidence</AlertTitle>
          <AlertDescription>No usage was recorded in the last 30 days.</AlertDescription>
        </Alert>
      )
    }

    return (
      <UsageDashboard
        usageRows={usageData.usage}
        customerId={customerId}
        workspaceSlug={workspaceSlug}
      />
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error while loading usage"
    return (
      <Alert variant="info">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Usage evidence could not be loaded</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    )
  }
}
