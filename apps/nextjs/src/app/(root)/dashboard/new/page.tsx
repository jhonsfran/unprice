import { getSession } from "@unprice/auth/server-rsc"
import { COOKIES_APP } from "@unprice/config"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { Suspense } from "react"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import LayoutLoader from "~/components/layout/layout-loader"
import { type SignupIntent, budgetsSetupPath, getSignupIntent } from "~/lib/signup-funnel"
import { api } from "~/trpc/server"
import NewWorkspaceForm from "../_components/new-workspace-form"
import Redirect from "./_components/redirect"

export default async function NewPage(props: {
  searchParams: Promise<{
    workspace_id?: string
    intent?: string | string[]
  }>
}) {
  const [{ workspace_id, intent }, cookieStore] = await Promise.all([props.searchParams, cookies()])
  const sessionId = cookieStore.get(COOKIES_APP.SESSION)?.value
  const signupIntent = getSignupIntent(intent)

  // A Budgets visitor who already has a workspace needs a key, not another workspace.
  if (signupIntent === "budgets" && !workspace_id) {
    const session = await getSession()
    const workspaceSlug = session?.user?.workspaces[0]?.slug
    if (workspaceSlug) {
      redirect(budgetsSetupPath(workspaceSlug))
    }
  }

  if (!sessionId) {
    return (
      <Suspense fallback={<LayoutLoader />}>
        <Content workspaceId={workspace_id} intent={signupIntent} />
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
        intent={signupIntent}
      />
    </Suspense>
  )
}

async function Content({
  workspaceId,
  planVersionId,
  sessionId,
  intent,
}: {
  workspaceId?: string
  planVersionId?: string
  sessionId?: string
  intent?: SignupIntent
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
                intent={intent}
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

  const slug = newWorkspace.workspace.slug
  return <Redirect url={intent === "budgets" ? budgetsSetupPath(slug) : slug} />
}
