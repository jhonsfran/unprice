import { Balancer } from "react-wrap-balancer"

import { getSession } from "@unprice/auth/server-rsc"
import { FEATURE_SLUGS } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { Typography } from "@unprice/ui/typography"
import { Plus } from "lucide-react"
import { Fragment } from "react"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import UpgradePlanError from "~/components/layout/error"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
import { entitlementFlag } from "~/lib/flags"
import { api } from "~/trpc/server"
import { ProjectCard, ProjectCardSkeleton } from "../_components/project-card"
import { ProjectDialog } from "../_components/project-dialog"

export default async function WorkspaceOverviewPage(props: {
  params: { workspaceSlug: string }
}) {
  const isProjectsEnabled = await entitlementFlag(FEATURE_SLUGS.PROJECTS.SLUG)

  const session = await getSession()
  const onboardingCompleted = session?.user?.onboardingCompleted ?? false

  if (!isProjectsEnabled) {
    return <UpgradePlanError />
  }

  const { projects } = await api.projects.listByWorkspace({
    workspaceSlug: props.params.workspaceSlug,
  })

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Projects"
          description="Projects group the plans, customers, events, wallets, and invoices in one money path."
          action={
            !onboardingCompleted ? (
              <SuperLink href={`/${props.params.workspaceSlug}/onboarding`}>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Create project
                </Button>
              </SuperLink>
            ) : (
              <ProjectDialog
                defaultValues={{
                  defaultCurrency: "USD",
                  timezone: "UTC",
                  name: "Acme project",
                  url: "https://acme.com",
                }}
              >
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Create project
                </Button>
              </ProjectDialog>
            )
          }
        />
      }
    >
      <Fragment>
        <ul className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {projects.map((project) => (
            <li key={project.id}>
              <ProjectCard project={project} workspaceSlug={props.params.workspaceSlug} />
            </li>
          ))}
        </ul>

        {projects.length === 0 && (
          <div className="relative">
            <ul className="grid select-none grid-cols-1 gap-4 opacity-40 lg:grid-cols-3">
              <ProjectCardSkeleton pulse={false} />
              <ProjectCardSkeleton pulse={false} />
              <ProjectCardSkeleton pulse={false} />
            </ul>
            <div className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 w-full text-center">
              <Balancer>
                <Typography variant="h2">No projects yet.</Typography>
                <Typography variant="large">
                  Create a project to start collecting events, customers, and invoice evidence.
                </Typography>
              </Balancer>
            </div>
          </div>
        )}
      </Fragment>
    </DashboardShell>
  )
}
