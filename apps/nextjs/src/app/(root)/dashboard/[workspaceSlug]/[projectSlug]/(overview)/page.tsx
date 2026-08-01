import { redirect } from "next/navigation"
import type { SearchParams } from "nuqs/server"

export default async function ProjectOverviewPage(props: {
  params: Promise<{ workspaceSlug: string; projectSlug: string }>
  searchParams: Promise<SearchParams>
}) {
  const { workspaceSlug, projectSlug } = await props.params
  // redirect to dashboard
  redirect(`/${workspaceSlug}/${projectSlug}/dashboard`)
}
