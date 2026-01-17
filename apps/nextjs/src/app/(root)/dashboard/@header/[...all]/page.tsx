import { getSession } from "@unprice/auth/server-rsc"
import { APP_NON_WORKSPACE_ROUTES } from "@unprice/config"
import { isSlug } from "@unprice/db/utils"
import { Separator } from "@unprice/ui/separator"
import { Fragment, Suspense } from "react"
import Flags from "~/components/layout/flags"
import Header from "~/components/layout/header"
import { Logo } from "~/components/layout/logo"
import { UserJotWrapper } from "~/components/userjot"
import { unprice } from "~/lib/unprice"
import { HydrateClient, prefetch, trpc } from "~/trpc/server"
import { ProjectSwitcher } from "../../_components/project-switcher"
import { ProjectSwitcherSkeleton } from "../../_components/project-switcher-skeleton"
import { UpdateClientCookie } from "../../_components/update-client-cookie"
import { WorkspaceSwitcher } from "../../_components/workspace-switcher"
import { WorkspaceSwitcherSkeleton } from "../../_components/workspace-switcher-skeleton"

export default async function Page(props: {
  params: {
    all: string[]
  }
  searchParams: {
    workspaceSlug: string
    projectSlug: string
  }
}) {
  const { all } = props.params
  const { workspaceSlug: ws, projectSlug: ps } = props.searchParams

  // delete first segment because it's always "/app" for the redirection from the middleware
  all.shift()

  const workspaceSlug = ws ?? all.at(0)
  const projectSlug = ps ?? all.at(1)

  // pages has another layout
  // if (all.length > 3 && all.includes("pages")) {
  //   return null
  // }

  let customerEntitlements: {
    [x: string]: boolean
  }[] = []

  let isMain = false
  let customerId = ""
  const session = await getSession()
  const user = session?.user

  if (isSlug(workspaceSlug)) {
    // prefetch data for the workspace and project
    prefetch(
      trpc.workspaces.listWorkspacesByActiveUser.queryOptions(undefined, {
        staleTime: 1000 * 60 * 60, // 1 hour
      })
    )

    const atw = session?.user.workspaces.find((w) => w.slug === workspaceSlug)

    if (atw) {
      isMain = atw.isMain
      customerId = atw.unPriceCustomerId

      // prefetch entitlements only for non-main workspaces
      if (!atw.isMain) {
        const { result: featuresEntitlements } = await unprice.customers.getEntitlements(customerId)

        const features = featuresEntitlements ?? []

        customerEntitlements = features.map((feature) => ({
          [feature.featureSlug]: true,
        }))
      }
    }
  }

  if (isSlug(projectSlug)) {
    prefetch(
      trpc.projects.listByActiveWorkspace.queryOptions(undefined, {
        staleTime: 1000 * 60 * 60, // 1 hour
      })
    )
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
                }
              : null
          }
        />
        <UpdateClientCookie workspaceSlug={workspaceSlug} projectSlug={projectSlug} />
        <Logo className="size-6 text-lg" />
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

          <Flags
            customerEntitlements={customerEntitlements}
            isMain={isMain}
            customerId={customerId}
          />

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
