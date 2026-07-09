import { notFound } from "next/navigation"
import { Fragment } from "react"
import { api } from "~/trpc/server"
import { DeleteProject } from "./_components/delete-project"
import { TransferProjectToPersonal } from "./_components/transfer-to-personal"
import { TransferProjectToTeam } from "./_components/transfer-to-team"

export default async function DangerZonePage(props: {
  params: { workspaceSlug: string; projectSlug: string }
}) {
  // get the project and the workspace
  const { project } = await api.projects.getBySlug({ slug: props.params.projectSlug })

  if (!project) {
    notFound()
  }

  // ordered by severity: transfers are recoverable, delete is not
  return (
    <Fragment>
      <TransferProjectToPersonal
        projectSlug={props.params.projectSlug}
        isMain={project.isMain ?? false}
      />
      <TransferProjectToTeam
        workspacesPromise={api.workspaces.listWorkspacesByActiveUser()}
        workspaceSlug={props.params.workspaceSlug}
        projectSlug={props.params.projectSlug}
        isMain={project.isMain ?? false}
      />
      <DeleteProject
        projectSlug={props.params.projectSlug}
        workspaceSlug={props.params.workspaceSlug}
        isMain={project.isMain ?? false}
      />
    </Fragment>
  )
}
