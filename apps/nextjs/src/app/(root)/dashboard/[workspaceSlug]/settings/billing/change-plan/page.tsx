import { Button } from "@unprice/ui/button"
import type { SearchParams } from "nuqs/server"
import { parseWorkspaceUpgradeIntent } from "~/components/billing/workspace-upgrade-intent"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
import { HydrateClient, api } from "~/trpc/server"
import { WorkspaceChangePlanClient } from "./_components/workspace-change-plan-client"

export const dynamic = "force-dynamic"

export default async function ChangePlanPage({
  params,
  searchParams,
}: {
  params: { workspaceSlug: string }
  searchParams: SearchParams
}) {
  const { workspaceSlug } = params
  const upgradeOptions = await api.workspaces.getUpgradeOptions({ workspaceSlug })
  const parsedSearchParams = toUrlSearchParams(searchParams)
  const intent = parseWorkspaceUpgradeIntent(parsedSearchParams)
  const currentUrl = getCurrentChangePlanUrl(workspaceSlug, parsedSearchParams)

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Change plan"
          description="Choose the workspace plan and when the change should take effect."
          action={
            <Button asChild variant="outline" size="sm">
              <SuperLink href={`/${workspaceSlug}/settings/billing`}>Back to billing</SuperLink>
            </Button>
          }
        />
      }
    >
      <HydrateClient>
        <WorkspaceChangePlanClient
          workspaceSlug={workspaceSlug}
          upgradeOptions={upgradeOptions}
          showFeatureBlockContext={
            intent?.source === "feature_block" && intent.workspaceSlug === workspaceSlug
          }
          initialTargetPlanVersionId={intent?.targetPlanVersionId}
          currentUrl={currentUrl}
        />
      </HydrateClient>
    </DashboardShell>
  )
}

function toUrlSearchParams(searchParams: SearchParams): URLSearchParams {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) {
          params.append(key, item)
        }
      }
      continue
    }

    if (value !== undefined) {
      params.set(key, value)
    }
  }

  return params
}

function getCurrentChangePlanUrl(workspaceSlug: string, searchParams: URLSearchParams): string {
  const queryString = searchParams.toString()
  const pathname = `/${workspaceSlug}/settings/billing/change-plan`

  return queryString ? `${pathname}?${queryString}` : pathname
}
