import { getSession } from "@unprice/auth/server-rsc"
import { attributionIdSchema } from "@unprice/db/validators"
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

export default async function NewPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [query, cookieStore] = await Promise.all([props.searchParams, cookies()])
  const workspace_id = getSingleSearchParam(query.workspace_id)
  // A malformed id is dropped here: the workspace form would reject it with nothing to correct.
  const attributionId = (value: string | undefined) => attributionIdSchema.safeParse(value).data
  const planVersionId = attributionId(getSingleSearchParam(query.planVersionId))
  // A page is attribution for a picked plan only.
  const pageId = planVersionId ? attributionId(getSingleSearchParam(query.pageId)) : undefined
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

  // The pricing CTA carries the clicked plan version and page; sign-up checks both belong to the
  // project.
  return (
    <Suspense fallback={<LayoutLoader />}>
      <Content
        workspaceId={workspace_id}
        planVersionId={planVersionId}
        pageId={pageId}
        intent={signupIntent}
      />
    </Suspense>
  )
}

async function Content({
  workspaceId,
  planVersionId,
  pageId,
  intent,
}: {
  workspaceId?: string
  planVersionId?: string
  pageId?: string
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
