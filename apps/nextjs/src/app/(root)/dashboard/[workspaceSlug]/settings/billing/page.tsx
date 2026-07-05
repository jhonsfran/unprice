import { getSession } from "@unprice/auth/server-rsc"
import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import { Button } from "@unprice/ui/button"
import { AlertCircle } from "lucide-react"
import type { SearchParams } from "nuqs/server"
import type { ReactNode } from "react"
import { PaymentMethodButton } from "~/components/forms/payment-method-form"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
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

  if (isMainWorkspace) {
    return (
      <BillingShell>
        <Alert variant="info">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Main Workspace</AlertTitle>
          <AlertDescription>
            This is the main workspace. No billing customer context is required here.
          </AlertDescription>
        </Alert>
      </BillingShell>
    )
  }

  if (!customerId) {
    return (
      <BillingShell>
        <Alert variant="info">
          <AlertTitle>No billing customer context</AlertTitle>
          <AlertDescription>
            This workspace has no billing customer configured yet.
          </AlertDescription>
        </Alert>
      </BillingShell>
    )
  }

  return <WorkspaceBillingCard workspaceSlug={workspaceSlug} range={filter.intervalFilter} />
}

function BillingShell({
  action,
  children,
}: {
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Billing & Usage"
          description="Plan, payment, and usage evidence for this workspace."
          action={action}
        />
      }
    >
      {children}
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
      <BillingShell
        action={
          overview.paymentProvider ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <PaymentMethodButton
                customerId={overview.customerId}
                successUrl={`/${workspaceSlug}/settings/billing`}
                cancelUrl={`/${workspaceSlug}/settings/billing`}
                paymentProvider={overview.paymentProvider}
                workspaceSlug={workspaceSlug}
                variant="link"
                size="default"
                hasPaymentMethods
              />
              <Button asChild>
                <SuperLink href={`/${workspaceSlug}/settings/billing/change-plan`}>
                  Change plan
                </SuperLink>
              </Button>
            </div>
          ) : null
        }
      >
        <HydrateClient>
          <WorkspaceBillingOverview
            initialOverview={overview}
            initialRange={range}
            workspaceSlug={workspaceSlug}
          />
        </HydrateClient>
      </BillingShell>
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error while loading workspace billing"

    return (
      <BillingShell>
        <Alert variant="info">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Workspace billing could not be loaded</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      </BillingShell>
    )
  }
}
