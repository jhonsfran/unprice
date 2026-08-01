import Balancer from "react-wrap-balancer"

import { FEATURE_SLUGS } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { Plus } from "@unprice/ui/icons"
import { Typography } from "@unprice/ui/typography"
import { Fragment } from "react"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import UpgradePlanError from "~/components/layout/error"
import HeaderTab from "~/components/layout/header-tab"
import { entitlementFlag } from "~/lib/flags"
import { api } from "~/trpc/server"
import { PageCard, PageCardSkeleton } from "../_components/page-card"
import { PageDialog } from "../_components/page-dialog"

export default async function PageOverviewPage(props: {
  params: Promise<{ workspaceSlug: string; projectSlug: string }>
}) {
  const [{ projectSlug, workspaceSlug }, isPagesEnabled] = await Promise.all([
    props.params,
    entitlementFlag(FEATURE_SLUGS.PAGES.SLUG),
  ])

  if (!isPagesEnabled) {
    return (
      <UpgradePlanError
        workspaceSlug={workspaceSlug}
        blockedFeatureSlug={FEATURE_SLUGS.PAGES.SLUG}
        returnTo={`/${workspaceSlug}/${projectSlug}/pages`}
      />
    )
  }

  const { pages } = await api.pages.listByActiveProject({})

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Pages"
          description="Create hosted pricing or signup pages that point customers at the right published plan version."
          action={
            <PageDialog>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add page
              </Button>
            </PageDialog>
          }
        />
      }
    >
      <Fragment>
        <ul className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {pages.map((page) => (
            <li key={page.id}>
              <PageCard page={page} workspaceSlug={workspaceSlug} projectSlug={projectSlug} />
            </li>
          ))}
        </ul>

        {pages.length === 0 && (
          <div className="relative">
            <ul className="grid select-none grid-cols-1 gap-4 opacity-40 lg:grid-cols-3">
              <PageCardSkeleton pulse={false} />
              <PageCardSkeleton pulse={false} />
              <PageCardSkeleton pulse={false} />
            </ul>
            <div className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 w-full text-center">
              <Balancer>
                <Typography variant="h2">This project has no pages yet</Typography>
                <Typography variant="large">
                  Create a page after you have a published plan version to route customers through.
                </Typography>
              </Balancer>
            </div>
          </div>
        )}
      </Fragment>
    </DashboardShell>
  )
}
