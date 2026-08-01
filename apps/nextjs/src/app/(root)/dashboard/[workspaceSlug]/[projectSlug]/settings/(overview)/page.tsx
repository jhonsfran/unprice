import { api } from "~/trpc/server"
import { RenameProjectForm } from "../_components/rename-project"

export default async function ProjectSettingsPage(props: {
  params: Promise<{ workspaceSlug: string; projectSlug: string }>
}) {
  const { projectSlug } = await props.params
  return (
    <div className="flex flex-col gap-4">
      <RenameProjectForm
        projectPromise={api.projects.getBySlug({
          slug: projectSlug,
        })}
      />
    </div>
  )
}
