import { notFound } from "next/navigation"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { api } from "~/trpc/server"
import { ProjectSettingsHeader } from "./_components/project-settings-header"

export default async function ProjectSettingsLayout(props: {
  children: React.ReactNode
  params: { workspaceSlug: string; projectSlug: string }
}) {
  const { project } = await api.projects.getBySlug({
    slug: props.params.projectSlug,
  })

  if (!project) {
    return notFound()
  }

  return (
    <DashboardShell header={<ProjectSettingsHeader project={project} />}>
      {props.children}
    </DashboardShell>
  )
}
