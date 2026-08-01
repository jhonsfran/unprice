import { getSession } from "@unprice/auth/server-rsc"
import { isSlug } from "@unprice/db/utils"
import { Sidebar } from "~/components/navigation/sidebar"
import { PROJECT_NAV, PROJECT_SHORTCUTS } from "~/constants/projects"
import { WORKSPACE_NAV, WORKSPACE_SHORTCUTS } from "~/constants/workspaces"
import type { DashboardRoute, Shortcut } from "~/types"

export default async function DashboardNavigationDesktopSlot(props: {
  params: Promise<{
    all: string[]
  }>
  searchParams: Promise<{
    workspaceSlug: string
    projectSlug: string
  }>
}) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams])
  const all = [...params.all]
  const { workspaceSlug, projectSlug } = searchParams

  // delete first segment because it's always "/app" for the redirection from the middleware
  all.shift()

  // If you want to hide the sidebar for a specific route, you can return null here
  if (all.length === 2 && all.includes("onboarding")) {
    return null
  }

  let routes = [] as DashboardRoute[]
  let shortcuts = [] as Shortcut[]
  let baseUrl = "/"
  let isMain = false

  if (isSlug(workspaceSlug) || isSlug(all.at(0))) {
    const session = await getSession()
    isMain =
      session?.user.workspaces.find((w) => w.slug === `${workspaceSlug ?? all.at(0)}`)?.isMain ??
      false

    routes = WORKSPACE_NAV
    shortcuts = WORKSPACE_SHORTCUTS
    baseUrl += `${workspaceSlug ?? all.at(0)}`
  }

  if (isSlug(projectSlug) || isSlug(all.at(1))) {
    routes = PROJECT_NAV
    shortcuts = PROJECT_SHORTCUTS
    baseUrl += `/${projectSlug ?? all.at(1)}`
  }

  // if the baseUrl is "/", it means the user is on the root of the dashboard
  if (baseUrl === "/") {
    return null
  }

  return <Sidebar routes={routes} shortcuts={shortcuts} baseUrl={baseUrl} isMain={isMain} />
}
