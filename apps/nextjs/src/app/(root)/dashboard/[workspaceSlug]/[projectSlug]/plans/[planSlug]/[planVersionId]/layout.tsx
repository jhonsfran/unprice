import type React from "react"

import { Button } from "@unprice/ui/button"
import { Code } from "lucide-react"
import { notFound } from "next/navigation"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { api } from "~/trpc/server"
import { PlanVersionPublish } from "../../_components/plan-version-actions"

export default async function PlanVersionLayout(props: {
  children: React.ReactNode
  params: {
    workspaceSlug: string
    projectSlug: string
    planSlug: string
    planVersionId: string
  }
}) {
  const { planVersion } = await api.planVersions.getById({
    id: props.params.planVersionId,
  })

  if (!planVersion) {
    notFound()
  }

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Plan Version Settings"
          description="Configure features and pricing for this plan version."
          action={
            <div className="flex items-center gap-2">
              <CodeApiSheet defaultMethod="listPlanVersions">
                <Button variant={"ghost"}>
                  <Code className="mr-2 h-4 w-4" />
                  API
                </Button>
              </CodeApiSheet>
              {planVersion.status !== "published" && (
                <PlanVersionPublish planVersionId={props.params.planVersionId} />
              )}
            </div>
          }
        />
      }
    >
      <div className="flex w-full flex-col justify-center">{props.children}</div>
    </DashboardShell>
  )
}
