import { COOKIES_APP } from "@unprice/config"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cookies } from "next/headers"
import { Suspense } from "react"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import LayoutLoader from "~/components/layout/layout-loader"
import { api } from "~/trpc/server"
import NewWorkspaceForm from "../_components/new-workspace-form"
import Redirect from "./_components/redirect"

export default async function NewPage(props: {
  searchParams: {
    workspace_id?: string
  }
}) {
  const { workspace_id } = props.searchParams
  const cookieStore = cookies()
  const sessionId = cookieStore.get(COOKIES_APP.SESSION)?.value

  if (!sessionId) {
    return (
      <Suspense fallback={<LayoutLoader />}>
        <Content workspaceId={workspace_id} />
      </Suspense>
    )
  }

  const { planClick } = await api.analytics.getPlanClickBySessionId({
    session_id: sessionId,
    action: "plan_click",
  })

  const session = planClick?.at(0) ?? null

  return (
    <Suspense fallback={<LayoutLoader />}>
      <Content
        workspaceId={workspace_id}
        planVersionId={session?.payload.plan_version_id}
        sessionId={session ? sessionId : undefined}
      />
    </Suspense>
  )
}

async function Content({
  workspaceId,
  planVersionId,
  sessionId,
}: {
  workspaceId?: string
  planVersionId?: string
  sessionId?: string
}) {
  if (!workspaceId || workspaceId === "") {
    return (
      <DashboardShell>
        <div className="flex min-h-[calc(100svh-10rem)] w-full flex-col items-center justify-start pt-[clamp(3rem,10svh,8rem)] pb-8">
          <Card className="w-full max-w-xl" variant="ghost">
            <CardHeader className="items-center text-center">
              <CardTitle>Create Workspace</CardTitle>
              <CardDescription className="max-w-sm">
                Create a new workspace to get started.
              </CardDescription>
            </CardHeader>
            <CardContent className="py-4">
              <NewWorkspaceForm
                defaultValues={{
                  name: "",
                  planVersionId,
                  successUrl: "",
                  cancelUrl: "",
                  sessionId: sessionId,
                }}
              />
            </CardContent>
          </Card>
        </div>
      </DashboardShell>
    )
  }

  // create the workspace
  const newWorkspace = await api.workspaces.create({
    workspaceId,
  })

  return <Redirect url={newWorkspace.workspace.slug} />
}
