import { notFound } from "next/navigation"
import { Fragment } from "react"
import { api } from "~/trpc/server"
import { DeleteProject } from "./_components/delete-project"
import { TransferProjectToPersonal } from "./_components/transfer-to-personal"
import { TransferProjectToTeam } from "./_components/transfer-to-team"

export default async function DangerZonePage(props: {
  params: Promise<{ workspaceSlug: string; projectSlug: string }>
}) {
  const { workspaceSlug, projectSlug } = await props.params
  // get the project and the workspace
  const { project } = await api.projects.getBySlug({ slug: projectSlug })

  if (!project) {
    notFound()
  }

  // ordered by severity: transfers are recoverable, delete is not
  return (
    <Fragment>
      <TransferProjectToPersonal projectSlug={projectSlug} isMain={project.isMain ?? false} />
      <TransferProjectToTeam
        workspacesPromise={api.workspaces.listWorkspacesByActiveUser()}
        workspaceSlug={workspaceSlug}
        projectSlug={projectSlug}
        isMain={project.isMain ?? false}
      />
      <DeleteProject
        projectSlug={projectSlug}
        workspaceSlug={workspaceSlug}
        isMain={project.isMain ?? false}
      />
    </Fragment>
  )
}
