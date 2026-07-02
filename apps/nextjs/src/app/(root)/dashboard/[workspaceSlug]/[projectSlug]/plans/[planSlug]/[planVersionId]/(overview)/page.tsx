import { Gauge, Layers3, PlusIcon, Send } from "lucide-react"
import { notFound } from "next/navigation"
import { Suspense } from "react"

import { Button } from "@unprice/ui/button"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { Typography } from "@unprice/ui/typography"

import { EvidenceMetricStrip, EvidenceMetricTile } from "~/components/analytics/evidence-panel"
import { SectionIntro } from "~/components/layout/section-intro"
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

  return (
    <DragDrop>
      <div className="flex flex-col gap-4">
        <SectionIntro
          title="Configure the plan version money path"
          description="Attach features first, configure meters and limits next, then preview customer behavior before publishing."
        />
        <EvidenceMetricStrip className="md:grid-cols-3">
          <EvidenceMetricTile
            label="1. Define features"
            value="Library"
            helper="Pick the sellable or gateable capabilities"
            icon={<Layers3 className="h-4 w-4" />}
          />
          <EvidenceMetricTile
            label="2. Configure rules"
            value="Meters + limits"
            helper="Make usage measurement and enforcement explicit"
            icon={<Gauge className="h-4 w-4" />}
          />
          <EvidenceMetricTile
            label="3. Publish"
            value="Customer version"
            helper="Customers stay pinned until migrated"
            icon={<Send className="h-4 w-4" />}
          />
        </EvidenceMetricStrip>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)_320px] lg:gap-0 lg:divide-x lg:rounded-lg lg:border">
          {/* ── Left: feature library ───────────────────────────── */}
          <aside className="flex min-h-0 flex-col">
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

          {/* ── Middle: features attached to this version ───────── */}
          <main className="flex min-h-0 flex-col">
            <PlanFeatureList planVersion={planVersion} />
          </main>

          {/* ── Right: customer preview + plan settings ─────────── */}
          <aside className="min-h-0 bg-muted/20 lg:rounded-r-lg">
            <div className="lg:sticky lg:top-4 lg:h-full lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
              <PlanWorkspaceRail planVersion={planVersion} />
            </div>
          </aside>
        </div>
      </div>
    </DragDrop>
  )
}
