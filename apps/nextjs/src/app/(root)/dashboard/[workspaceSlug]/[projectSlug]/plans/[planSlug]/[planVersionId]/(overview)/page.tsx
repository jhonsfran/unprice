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

  // a published version is immutable: the feature library would render fully
  // disabled, so the column collapses and the attached features get the room
  const isPublished = planVersion.status === "published"

  return (
    <DragDrop>
      <div className="flex flex-col gap-4">
        {/* bounded workbench: the grid owns the height on lg and each pane
            scrolls internally, so long feature lists can't stretch the page */}
        <div
          className={
            isPublished
              ? "grid grid-cols-1 gap-4 lg:h-[max(560px,calc(100vh-18rem))] lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-0 lg:divide-x lg:rounded-lg lg:border"
              : "grid grid-cols-1 gap-4 lg:h-[max(560px,calc(100vh-16rem))] lg:grid-cols-[280px_minmax(0,1fr)_320px] lg:gap-0 lg:divide-x lg:rounded-lg lg:border"
          }
        >
          {/* ── Left: feature library (draft versions only) ─────── */}
          {!isPublished && (
            <aside className="flex min-h-0 flex-col lg:overflow-hidden">
              <div className="flex h-[70px] items-center justify-between px-4">
                <Typography variant="h4">Feature library</Typography>
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
          )}

          {/* ── Middle: features attached to this version ───────── */}
          <main className="flex min-h-0 flex-col lg:overflow-hidden">
            <PlanFeatureList planVersion={planVersion} />
          </main>

          {/* ── Right: version preview + settings ─────────── */}
          <aside className="min-h-0 bg-muted/20 lg:overflow-hidden lg:rounded-r-lg">
            <div className="lg:h-full lg:overflow-y-auto">
              <PlanWorkspaceRail planVersion={planVersion} />
            </div>
          </aside>
        </div>
      </div>
    </DragDrop>
  )
}
