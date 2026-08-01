import { notFound } from "next/navigation"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { api } from "~/trpc/server"
import { ProjectSettingsHeader } from "./_components/project-settings-header"

export default async function ProjectSettingsLayout(props: {
  children: React.ReactNode
  params: Promise<{ workspaceSlug: string; projectSlug: string }>
}) {
  const { projectSlug } = await props.params
  const { project } = await api.projects.getBySlug({
    slug: projectSlug,
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
