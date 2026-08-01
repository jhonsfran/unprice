import { getSession } from "@unprice/auth/server-rsc"
import { APP_NON_WORKSPACE_ROUTES } from "@unprice/config"
import { isSlug } from "@unprice/db/utils"
import { Separator } from "@unprice/ui/separator"
import { cache } from "react"
import { Fragment, Suspense } from "react"
import Header from "~/components/layout/header"
import { Logo } from "~/components/layout/logo"
import { UserJotWrapper } from "~/components/userjot"
import { getUserJotToken } from "~/lib/userjot"
import { HydrateClient, prefetch, trpc } from "~/trpc/server"
import { ProjectSwitcher } from "../../_components/project-switcher"
import { ProjectSwitcherSkeleton } from "../../_components/project-switcher-skeleton"
import { UpdateClientCookie } from "../../_components/update-client-cookie"
import { WorkspaceSwitcher } from "../../_components/workspace-switcher"
import { WorkspaceSwitcherSkeleton } from "../../_components/workspace-switcher-skeleton"

// Cache prefetch calls to prevent duplicate requests on re-renders
const prefetchProjects = cache(() => {
  prefetch(
    trpc.projects.listByActiveWorkspace.queryOptions(undefined, {
      staleTime: 1000 * 60 * 60, // 1 hour
    })
  )
})

const prefetchWorkspaces = cache(() => {
  prefetch(
    trpc.workspaces.listWorkspacesByActiveUser.queryOptions(undefined, {
      staleTime: 1000 * 60 * 60, // 1 hour
    })
  )
})

export default async function Page(props: {
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
  const { workspaceSlug: ws, projectSlug: ps } = searchParams

  // delete first segment because it's always "/app" for the redirection from the middleware
  all.shift()

  const workspaceSlug = ws ?? all.at(0)
  const projectSlug = ps ?? all.at(1)

  // pages has another layout
  // if (all.length > 3 && all.includes("pages")) {
  //   return null
  // }

  const session = await getSession()
  const user = session?.user

  if (isSlug(workspaceSlug)) {
    // prefetch data for the workspace and project
    prefetchWorkspaces()
  }

  if (isSlug(projectSlug)) {
    prefetchProjects()
  }

  const isNonWorkspaceRoute = APP_NON_WORKSPACE_ROUTES.has(`/${workspaceSlug}`)

  if ((!workspaceSlug || isNonWorkspaceRoute) && (!projectSlug || !isSlug(projectSlug))) {
    return (
      <Header className="px-4">
        <UserJotWrapper
          user={
            user
              ? {
                  id: user.id,
                  email: user.email,
                  firstName: user.name ?? "",
                  avatar: user.image ?? "",
                  signature: getUserJotToken(user.id),
                }
              : null
          }
        />
        <UpdateClientCookie workspaceSlug={workspaceSlug} projectSlug={projectSlug} />
        <Logo />
      </Header>
    )
  }

  return (
    <Header>
      <UserJotWrapper
        user={
          user
            ? {
                id: user.id,
                email: user.email,
                firstName: user.name ?? "",
                avatar: user.image ?? "",
                signature: getUserJotToken(user.id),
              }
            : null
        }
      />
      <UpdateClientCookie workspaceSlug={workspaceSlug} projectSlug={projectSlug} />
      <HydrateClient>
        <Fragment>
          {workspaceSlug && (
            <Suspense fallback={<WorkspaceSwitcherSkeleton />}>
              <WorkspaceSwitcher workspaceSlug={workspaceSlug} />
            </Suspense>
          )}

          {isSlug(projectSlug) && (
            <Fragment>
              <div className="flex size-4 items-center justify-center px-2">
                <Separator className="rotate-[30deg]" orientation="vertical" />
              </div>
              <Suspense fallback={<ProjectSwitcherSkeleton />}>
                <ProjectSwitcher />
              </Suspense>
            </Fragment>
          )}
        </Fragment>
      </HydrateClient>
    </Header>
  )
}
