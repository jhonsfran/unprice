"use client"

import { Button } from "@unprice/ui/button"
import { usePathname, useRouter } from "next/navigation"
import { WorkspaceUpgradeEntrypoint } from "~/components/billing/workspace-upgrade-entrypoint"
import { BlurImage } from "~/components/blur-image"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { DashboardShell } from "~/components/layout/dashboard-shell"

export default function UpgradePlanError(props: {
  workspaceSlug: string
  blockedFeatureSlug?: string
  returnTo?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const returnTo = props.returnTo ?? pathname

  return (
    <DashboardShell>
      <div className="flex flex-col items-center justify-center">
        <EmptyPlaceholder className="min-h-[800px] w-full space-y-10">
          <EmptyPlaceholder.Title className="mt-0 p-10" variant="h3">
            This feature is not available on your current plan
          </EmptyPlaceholder.Title>
          <EmptyPlaceholder.Icon>
            <BlurImage
              alt="missing site"
              src="/app-launch.svg"
              width={400}
              height={400}
              className="invert-0 filter dark:invert"
            />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Description className="mx-auto w-1/3 text-center">
            This feature is not available on your current plan
          </EmptyPlaceholder.Description>
          <EmptyPlaceholder.Action>
            <div className="mt-6 flex flex-row items-center justify-center gap-10">
              <WorkspaceUpgradeEntrypoint
                intent={{
                  source: "feature_block",
                  workspaceSlug: props.workspaceSlug,
                  returnTo,
                  blockedFeatureSlug: props.blockedFeatureSlug,
                }}
              >
                Update plan
              </WorkspaceUpgradeEntrypoint>
              <Button variant="default" onClick={() => router.back()}>
                Back
              </Button>
            </div>
          </EmptyPlaceholder.Action>
        </EmptyPlaceholder>
      </div>
    </DashboardShell>
  )
}
