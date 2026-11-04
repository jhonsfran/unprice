import { getSession } from "@unprice/auth/server-rsc"
import { COOKIES_APP } from "@unprice/config"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { Suspense } from "react"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import LayoutLoader from "~/components/layout/layout-loader"
import {
  SIGNUP_INTENT_COOKIE,
  type SignupIntent,
  getSingleSearchParam,
  intentLanding,
  resolveSignupIntent,
  workspaceLanding,
} from "~/lib/signup-funnel"
import { api } from "~/trpc/server"
import NewWorkspaceForm from "../_components/new-workspace-form"
import Redirect from "./_components/redirect"

/** /new renders without attribution rather than wait on Basin SQL longer than this. */
const PLAN_CLICK_LOOKUP_TIMEOUT_MS = 3_000

/**
 * The session's latest plan click, or null when there is none, the lookup fails, or it takes longer
 * than the timeout: attribution is optional, so it never blocks or breaks workspace creation.
 */
async function findPlanClick(sessionId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PLAN_CLICK_LOOKUP_TIMEOUT_MS)
  })
  const lookup = api.analytics
    .getPlanClickBySessionId({ session_id: sessionId })
    .then(({ planClick }) => planClick)
    .catch(() => null)

  try {
    return await Promise.race([lookup, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export default async function NewPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [query, cookieStore] = await Promise.all([props.searchParams, cookies()])
  const workspace_id = getSingleSearchParam(query.workspace_id)
  const planVersionId = getSingleSearchParam(query.planVersionId)
  const pageId = getSingleSearchParam(query.pageId)
  // A pricing CTA on another domain cannot set the app's cookie, so its query wins.
  const sessionId =
    getSingleSearchParam(query.sessionId) || cookieStore.get(COOKIES_APP.SESSION)?.value
  // The query carries the intent through auth; the signup cookie covers a round trip that lost it.
  const signupIntent = resolveSignupIntent(
    query.intent,
    cookieStore.get(SIGNUP_INTENT_COOKIE)?.value
  )

  // A visitor whose intent has its own landing and who already runs a workspace goes there, not
  // to another workspace. Only a workspace they own or administer: an invited member cannot set up
  // someone else's.
  if (signupIntent && !workspace_id) {
    const session = await getSession()
    const workspaces = session?.user?.workspaces ?? []
    const owned =
      workspaces.find((workspace) => workspace.isPersonal) ??
      workspaces.find((workspace) => workspace.role === "OWNER" || workspace.role === "ADMIN")
    const landing = owned ? intentLanding(owned.slug, signupIntent) : null
    if (landing) {
      redirect(landing)
    }
  }

  // The pricing CTA carries the clicked plan version. Sign-up checks it belongs to the project;
  // the plan-click lookup is only a fallback because analytics reach R2 minutes later.
  if (planVersionId || !sessionId) {
    return (
      <Suspense fallback={<LayoutLoader />}>
        <Content
          workspaceId={workspace_id}
          planVersionId={planVersionId}
          pageId={planVersionId ? pageId : undefined}
          sessionId={planVersionId ? sessionId : undefined}
          intent={signupIntent}
        />
      </Suspense>
    )
  }

  const planClick = await findPlanClick(sessionId)

  return (
    <Suspense fallback={<LayoutLoader />}>
      <Content
        workspaceId={workspace_id}
        planVersionId={planClick?.payload.plan_version_id}
        pageId={planClick?.payload.page_id}
        sessionId={planClick ? sessionId : undefined}
        intent={signupIntent}
      />
    </Suspense>
  )
}

async function Content({
  workspaceId,
  planVersionId,
  pageId,
  sessionId,
  intent,
}: {
  workspaceId?: string
  planVersionId?: string
  pageId?: string
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
                  pageId,
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
  return <Redirect url={workspaceLanding(slug, intent)} />
}
