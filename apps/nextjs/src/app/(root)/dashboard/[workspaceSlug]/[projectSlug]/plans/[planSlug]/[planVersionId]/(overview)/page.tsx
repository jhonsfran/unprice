import { notFound } from "next/navigation"

import { api } from "~/trpc/server"
import DragDrop from "../../../_components/drag-drop"
import { PlanFeatureList } from "../../_components/plan-feature-list"
import { PlanWorkspaceRail } from "../_components/plan-workspace-rail"

export default async function OverviewVersionPage(props: {
  params: Promise<{
    workspaceSlug: string
    projectSlug: string
    planSlug: string
    planVersionId: string
  }>
}) {
  const params = await props.params
  const { planVersion } = await api.planVersions.getById({
    id: params.planVersionId,
  })

  if (!planVersion) {
    notFound()
  }

  return (
    <DragDrop>
      <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1">
        {/* bounded workbench: on lg the grid flex-fills the dashboard content well
            (via DashboardShell `fullHeight`) instead of a fixed vh height, so it can
            never overflow the well regardless of header/breadcrumb chrome height, and
            each pane scrolls internally */}
        <div className="grid grid-cols-1 gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-0 lg:divide-x lg:rounded-lg lg:border">
          {/* ── Left: the features attached to this version, as a table ───── */}
          <main className="flex min-h-0 flex-col lg:overflow-hidden">
            <PlanFeatureList planVersion={planVersion} />
          </main>

          {/* ── Right: checklist, settings, card, preview ─────────── */}
          <aside className="min-h-0 bg-muted/20 lg:overflow-hidden lg:rounded-r-lg">
            {/* hide-scrollbar + overscroll-contain: keep the thick native bar out of the rail
                and stop its scroll from chaining into the dashboard content well */}
            <div className="hide-scrollbar overscroll-contain lg:h-full lg:overflow-y-auto">
              <PlanWorkspaceRail planVersion={planVersion} />
            </div>
          </aside>
        </div>
      </div>
    </DragDrop>
  )
}
