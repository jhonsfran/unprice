import type React from "react"

import { Code } from "lucide-react"
import { notFound } from "next/navigation"

import { Button } from "@unprice/ui/button"

import { CodeApiSheet } from "~/components/code-api-sheet"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { api } from "~/trpc/server"
import { BannerInactiveVersion, BannerPublishedVersion } from "./_components/banner"
import { PlanVersionHeaderActions } from "./_components/plan-version-header-actions"
import { VersionContextStrip } from "./_components/version-context-strip"

export default async function PlanVersionLayout(props: {
  children: React.ReactNode
  params: {
    workspaceSlug: string
    projectSlug: string
    planSlug: string
    planVersionId: string
  }
}) {
  const { getVersionsBySlug } = api.plans
  const [{ planVersion }, { plan }] = await Promise.all([
    api.planVersions.getById({ id: props.params.planVersionId }),
    getVersionsBySlug({ slug: props.params.planSlug }),
  ])

  if (!planVersion) {
    notFound()
  }

  const status = planVersion.status ?? "draft"
  const active = planVersion.active ?? true
  const headerLabel = !active ? "inactive" : status
  const description = planVersion.description ?? planVersion.plan.description ?? undefined
  const baseHref = `/${props.params.workspaceSlug}/${props.params.projectSlug}/plans/${props.params.planSlug}`
  const listPlanVersionsExampleParams = {
    listPlanVersions: {
      planVersionIds: [planVersion.id],
      billingInterval: planVersion.billingConfig.billingInterval,
      currency: planVersion.currency,
      version: planVersion.version,
      featureSlugs: planVersion.planFeatures.map((planFeature) => planFeature.feature.slug),
    },
  }

  return (
    <DashboardShell
      fullHeight
      header={
        <div className="flex w-full flex-col gap-3">
          <HeaderTab
            title={`${planVersion.plan.title} · v${planVersion.version}`}
            id={planVersion.id}
            description={description}
            label={headerLabel}
            action={
              <div className="flex items-center gap-2">
                <CodeApiSheet
                  defaultMethod="listPlanVersions"
                  exampleParams={listPlanVersionsExampleParams}
                >
                  <Button variant={"ghost"}>
                    <Code className="mr-2 h-4 w-4" />
                    API
                  </Button>
                </CodeApiSheet>
                <PlanVersionHeaderActions
                  planVersionId={planVersion.id}
                  status={status}
                  active={active}
                />
              </div>
            }
          />
          <VersionContextStrip
            currentId={planVersion.id}
            baseHref={baseHref}
            versions={plan.versions}
          />
        </div>
      }
    >
      <div className="flex w-full flex-col justify-center gap-4 lg:min-h-0 lg:flex-1">
        {!active ? (
          <BannerInactiveVersion />
        ) : status === "published" ? (
          <BannerPublishedVersion />
        ) : null}
        {props.children}
      </div>
    </DashboardShell>
  )
}
