import { PlusIcon } from "lucide-react"
import { notFound } from "next/navigation"
import { Suspense } from "react"

import { Button } from "@unprice/ui/button"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { Typography } from "@unprice/ui/typography"

import { api } from "~/trpc/server"
import DragDrop from "../../../_components/drag-drop"
import { FeatureDialog } from "../../../_components/feature-dialog"
import { FeatureList } from "../../_components/feature-list"
import { PlanFeatureList } from "../../_components/plan-feature-list"
import { BannerInactiveVersion } from "../_components/banner"
import { PlanWorkspaceRail } from "../_components/plan-workspace-rail"

export default async function OverviewVersionPage({
  params,
}: {
  params: {
    workspaceSlug: string
    projectSlug: string
    planSlug: string
    planVersionId: string
  }
}) {
  const { planVersion } = await api.planVersions.getById({
    id: params.planVersionId,
  })

  if (!planVersion) {
    notFound()
  }

  return (
    <DragDrop>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)_380px] lg:gap-0 lg:divide-x lg:rounded-lg lg:border">
        {/* ── Left: feature library ───────────────────────────── */}
        <aside className="flex min-h-0 flex-col">
          <div className="flex h-[70px] items-center justify-between px-4">
            <Typography variant="h4">All features</Typography>
            <FeatureDialog>
              <Button variant="default" size="sm">
                <PlusIcon className="h-3.5 w-3.5" />
              </Button>
            </FeatureDialog>
          </div>

          <div className="border-t" />

          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <LoadingAnimation className="size-6" />
              </div>
            }
          >
            <FeatureList
              planVersion={planVersion}
              featuresPromise={api.features.listByActiveProject()}
            />
          </Suspense>
        </aside>

        {/* ── Middle: features attached to this version ───────── */}
        <main className="flex min-h-0 flex-col">
          {!planVersion.active && (
            <div className="px-4 pt-4">
              <BannerInactiveVersion />
            </div>
          )}
          <PlanFeatureList planVersion={planVersion} />
        </main>

        {/* ── Right: customer preview + plan settings ─────────── */}
        <aside className="min-h-0">
          <div className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            <PlanWorkspaceRail planVersion={planVersion} />
          </div>
        </aside>
      </div>
    </DragDrop>
  )
}
